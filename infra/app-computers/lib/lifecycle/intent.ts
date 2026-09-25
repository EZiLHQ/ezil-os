import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const positive = z.number().int().min(1).max(2147483647);
export { LifecycleDeploymentSchema, type LifecycleDeployment } from './deployment.js';
import { LifecycleDeploymentSchema } from './deployment.js';
const instance = z.string().regex(/^i-[a-f0-9]{17}$/), volume = z.string().regex(/^vol-[a-f0-9]{17}$/);
export const LifecycleIntentSchema = z.object({
    schemaVersion: z.literal(1), jobId: uuid, computerId: uuid, revision: positive,
    operation: z.enum(['provision', 'start', 'stop', 'replace', 'retire']), targetGeneration: positive, fenceToken: uuid,
    providerInstanceId: instance.nullable(), dataVolumeId: volume.nullable(), previousGeneration: positive.nullable(),
    previousInstanceId: instance.nullable(), previousFenceToken: uuid.nullable(), deployment: LifecycleDeploymentSchema,
}).strict().refine(i => {
    if (i.operation === 'replace') return i.providerInstanceId === null && i.dataVolumeId !== null
        && i.previousGeneration !== null && i.previousGeneration < i.targetGeneration
        && i.previousInstanceId !== null && i.previousFenceToken !== null && i.previousFenceToken !== i.fenceToken;
    if (i.previousGeneration !== null || i.previousInstanceId !== null || i.previousFenceToken !== null) return false;
    return i.operation === 'provision' ? i.providerInstanceId === null && i.dataVolumeId === null
        : i.providerInstanceId !== null && i.dataVolumeId !== null;
});
export type LifecycleIntent = z.infer<typeof LifecycleIntentSchema>;
export interface LifecycleWork { document: string; digest: string; createdAt: Date }
export class LifecycleError extends Error {
    constructor(readonly code: 'lifecycle_invalid' | 'lifecycle_unavailable' | 'lifecycle_conflict' | 'lifecycle_unconfirmed') { super(code); }
}
export function parseLifecycleWork(work: LifecycleWork): LifecycleIntent {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 16384
            || !/^[a-f0-9]{64}$/.test(work.digest) || !(work.createdAt instanceof Date) || !Number.isFinite(work.createdAt.getTime())
            || createHash('sha256').update(work.document, 'utf8').digest('hex') !== work.digest) throw new Error();
        return LifecycleIntentSchema.parse(JSON.parse(work.document));
    } catch { throw new LifecycleError('lifecycle_invalid'); }
}

/** Output is a provider receipt only. It never certifies mounted disk, host
 * configuration, application readiness, ownership or permission to launch. */
export const LifecycleReceiptSchema = z.object({
    schemaVersion: z.literal(1), jobId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/),
    computerId: uuid, generation: positive, fenceToken: uuid, instanceId: instance, volumeId: volume,
    state: z.enum(['running', 'stopped', 'retired']),
}).strict();
export type LifecycleReceipt = z.infer<typeof LifecycleReceiptSchema>;
export function validateLifecycleReceipt(work: LifecycleWork, input: unknown): LifecycleReceipt {
    const intent = parseLifecycleWork(work), parsed = LifecycleReceiptSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data;
    const state = intent.operation === 'retire' ? 'retired' : intent.operation === 'stop' ? 'stopped' : 'running';
    if (r.jobId !== intent.jobId || r.digest !== work.digest || r.computerId !== intent.computerId
        || r.generation !== intent.targetGeneration || r.fenceToken !== intent.fenceToken || r.state !== state
        || (intent.providerInstanceId !== null && r.instanceId !== intent.providerInstanceId)
        || (intent.dataVolumeId !== null && r.volumeId !== intent.dataVolumeId)
        || r.instanceId === intent.previousInstanceId) throw new LifecycleError('lifecycle_conflict');
    return r;
}
