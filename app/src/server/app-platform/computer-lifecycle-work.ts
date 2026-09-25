import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseComputerRecoveryWork } from './computer-recovery-protocol';
import { LifecycleError, LifecycleReceiptSchema, parseLifecycleWork, validateLifecycleReceipt, type LifecycleWork } from './lifecycle-protocol';
import { LifecycleRecoveryReceiptSchema, validateLifecycleRecoveryReceipt } from './lifecycle-recovery-protocol';

/** V1 parsers and serialized documents stay unchanged. */
export function parseComputerLifecycleWork(work: LifecycleWork) {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 16384) throw new Error();
        return JSON.parse(work.document).schemaVersion === 2 ? parseComputerRecoveryWork(work) : parseLifecycleWork(work);
    }
    catch { throw new LifecycleError('lifecycle_invalid'); }
}
export const ComputerRecoveryReceiptSchema = LifecycleReceiptSchema.extend({ schemaVersion: z.literal(2), state: z.literal('running') });
export const ComputerRecoveryCleanupSchema = LifecycleRecoveryReceiptSchema.extend({
    schemaVersion: z.literal(2), volumeId: z.string().regex(/^vol-[a-f0-9]{17}$/),
    instances: LifecycleRecoveryReceiptSchema.shape.instances.max(1),
});
export type ComputerRecoveryReceipt = z.infer<typeof ComputerRecoveryReceiptSchema>;
export type ComputerRecoveryCleanup = z.infer<typeof ComputerRecoveryCleanupSchema>;
export function validateComputerLifecycleReceipt(work: LifecycleWork, input: unknown) {
    const i = parseComputerLifecycleWork(work);
    if (i.schemaVersion === 1) return validateLifecycleReceipt(work, input);
    const parsed = ComputerRecoveryReceiptSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data;
    if (r.jobId !== i.jobId || r.digest !== work.digest || r.computerId !== i.computerId || r.generation !== i.targetGeneration
        || r.fenceToken !== i.fenceToken || r.volumeId !== i.dataVolumeId) throw new LifecycleError('lifecycle_conflict');
    return r;
}
export function validateComputerLifecycleCleanup(work: LifecycleWork, input: unknown) {
    const i = parseComputerLifecycleWork(work);
    if (i.schemaVersion === 1) return validateLifecycleRecoveryReceipt(work, input);
    const parsed = ComputerRecoveryCleanupSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data, version = i.deployment.stateMachineVersionArn;
    const arn = version.slice(0, version.lastIndexOf(':')).replace(':stateMachine:', ':execution:') + `:computer-${i.jobId}`;
    if (r.sourceExecutionArn !== arn || r.jobId !== i.jobId || r.digest !== work.digest || r.computerId !== i.computerId
        || r.volumeId !== i.dataVolumeId || r.instances.some(v => v.generation !== i.targetGeneration || v.fenceToken !== i.fenceToken)) {
        throw new LifecycleError('lifecycle_conflict');
    }
    return r;
}
export function computerLifecycleAllocationToken(work: LifecycleWork, kind: 'instance' | 'volume') {
    const i = parseComputerLifecycleWork(work);
    return createHash('sha256').update(`ezil-lifecycle-v${i.schemaVersion}\n${kind}\n${work.digest}`).digest('hex');
}
