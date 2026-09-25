import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema } from './lifecycle-deployment';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const generation = z.number().int().min(1).max(2147483647);
export const ComputerRecoveryIntentV2Schema = z.object({
    schemaVersion: z.literal(2), operation: z.literal('recover'), jobId: uuid, computerId: uuid,
    revision: generation, targetGeneration: generation, fenceToken: uuid,
    source: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), jobId: uuid,
        digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/),
    dataScope: z.object({ generation, fenceToken: uuid }).strict(), deployment: LifecycleDeploymentSchema,
}).strict().refine(i => i.source.jobId !== i.jobId && i.targetGeneration > i.dataScope.generation && i.fenceToken !== i.dataScope.fenceToken,
    { message: 'invalid_recovery_scope' });
export type ComputerRecoveryIntentV2 = z.infer<typeof ComputerRecoveryIntentV2Schema>;

/** Contract validation is not ownership, administrator or provider authority.
 * No parser starts compute or claims the retained disk is safe to attach. */
export function parseComputerRecoveryWork(work: LifecycleWork): ComputerRecoveryIntentV2 {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 16384
            || !/^[a-f0-9]{64}$/.test(work.digest) || !(work.createdAt instanceof Date) || !Number.isFinite(work.createdAt.getTime())
            || createHash('sha256').update(work.document, 'utf8').digest('hex') !== work.digest) throw new Error();
        return ComputerRecoveryIntentV2Schema.parse(JSON.parse(work.document));
    } catch { throw new LifecycleError('lifecycle_invalid'); }
}
