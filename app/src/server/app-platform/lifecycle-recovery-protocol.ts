import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleError, parseLifecycleWork, type LifecycleWork } from './lifecycle-protocol';

const uuid = z.string().uuid();
export const LifecycleRecoveryReceiptSchema = z.object({
    schemaVersion: z.literal(1), sourceExecutionArn: z.string().max(300), jobId: uuid,
    digest: z.string().regex(/^[a-f0-9]{64}$/), computerId: uuid, state: z.literal('fenced'),
    volumeId: z.string().regex(/^vol-[a-f0-9]{17}$/).nullable(),
    instances: z.array(z.object({ instanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
        generation: z.number().int().min(1).max(2147483647), fenceToken: uuid, state: z.literal('terminated') }).strict()).max(2),
}).strict();
export type LifecycleRecoveryReceipt = z.infer<typeof LifecycleRecoveryReceiptSchema>;
export const lifecycleAllocationToken = (digest: string, kind: 'instance' | 'volume') =>
    createHash('sha256').update(`ezil-lifecycle-v1\n${kind}\n${digest}`).digest('hex');

/** Shape/scope validation only. The AWS adapter must independently prove
 * terminated writers, detached storage and any claimed absence of allocation. */
export function validateLifecycleRecoveryReceipt(work: LifecycleWork, input: unknown): LifecycleRecoveryReceipt {
    const i = parseLifecycleWork(work), parsed = LifecycleRecoveryReceiptSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data, version = i.deployment.stateMachineVersionArn;
    const source = version.slice(0, version.lastIndexOf(':')).replace(':stateMachine:', ':execution:') + `:computer-${i.jobId}`;
    const original = i.previousInstanceId ?? i.providerInstanceId;
    if (r.sourceExecutionArn !== source || r.jobId !== i.jobId || r.digest !== work.digest || r.computerId !== i.computerId
        || (i.dataVolumeId !== null && r.volumeId !== i.dataVolumeId) || (r.instances.length > 0 && r.volumeId === null)
        || new Set(r.instances.map(v => v.instanceId)).size !== r.instances.length
        || new Set(r.instances.map(v => v.generation)).size !== r.instances.length) throw new LifecycleError('lifecycle_conflict');
    if (original && !r.instances.some(v => v.instanceId === original)) throw new LifecycleError('lifecycle_conflict');
    for (const v of r.instances) {
        const old = v.instanceId === original;
        if (!old && !['provision', 'replace'].includes(i.operation)) throw new LifecycleError('lifecycle_conflict');
        if (v.generation !== (old ? i.previousGeneration ?? i.targetGeneration : i.targetGeneration)
            || v.fenceToken !== (old ? i.previousFenceToken ?? i.fenceToken : i.fenceToken)) throw new LifecycleError('lifecycle_conflict');
    }
    return r;
}
