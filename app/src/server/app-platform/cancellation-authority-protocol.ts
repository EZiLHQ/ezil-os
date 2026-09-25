import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';
import { LifecycleRecoveryReceiptSchema } from './lifecycle-recovery-protocol';
import { ComputerRecoveryCleanupSchema, validateComputerLifecycleCleanup } from './computer-lifecycle-work';
import { parseComputerCancellation } from './computer-cancellation-protocol';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CANCELLATION_AUTHORITY_PATH = '/api/internal/computers/cancellation-authority';
export const CancellationAuthoritySecretSchema = digest;
export const CancellationAuthorityRequestSchema = z.object({ schemaVersion: z.literal(1), computerId: uuid,
    cancellationId: uuid, digest }).strict();
export type CancellationAuthorityRequest = z.infer<typeof CancellationAuthorityRequestSchema>;
export const CancellationWritersSchema = z.array(z.object({ instanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
    generation: z.number().int().min(1).max(2147483647), fenceToken: uuid,
    observedState: z.enum(['pending','starting','running','stopping','stopped','failed']),
    observedAt: z.string().datetime().nullable(), fencedAt: z.string().datetime().nullable(),
}).strict()).max(128).refine(rows => new Set(rows.map(r => r.instanceId)).size === rows.length
    && new Set(rows.map(r => r.generation)).size === rows.length);
export type CancellationWriters = z.infer<typeof CancellationWritersSchema>;
export const CancellationAuthorityScopeSchema = z.object({
    source: z.object({ schemaVersion: z.union([z.literal(1),z.literal(2)]), jobId: uuid, digest }).strict(),
    dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/).nullable(), writers: CancellationWritersSchema,
}).strict();
export type CancellationAuthorityScope = z.infer<typeof CancellationAuthorityScopeSchema>;
export const CancellationReceiptSchema = z.object({ schemaVersion: z.literal(1), computerId: uuid,
    cancellationId: uuid, digest, source: z.union([LifecycleRecoveryReceiptSchema, ComputerRecoveryCleanupSchema]),
}).strict();
export type CancellationReceipt = z.infer<typeof CancellationReceiptSchema>;

/** Shape and original-source scope only; the transport must independently
 * observe provider history, exact terminated writers and preserved storage. */
export function validateCancellationReceipt(work: LifecycleWork, source: LifecycleWork, input: unknown): CancellationReceipt {
    const c = parseComputerCancellation(work, source), parsed = CancellationReceiptSchema.safeParse(input);
    if (!parsed.success) throw new LifecycleError('lifecycle_conflict');
    const r = parsed.data;
    if (r.computerId !== c.computerId || r.cancellationId !== c.cancellationId || r.digest !== work.digest) throw new LifecycleError('lifecycle_conflict');
    validateComputerLifecycleCleanup(source, r.source);
    return r;
}

/** Dedicated realm/path/key. Fresh replay rechecks the pending cancellation;
 * a response is not reusable permission to mutate a different execution. */
export function cancellationAuthoritySignature(body: Uint8Array, secret: string, timestamp: string): string {
    if (!CancellationAuthoritySecretSchema.safeParse(secret).success || !/^[0-9]{10}$/.test(timestamp)) {
        throw new Error('cancellation_authority_signing_invalid');
    }
    return createHmac('sha256', Buffer.from(secret, 'hex')).update([
        'ezil-cancellation-authority-v1', 'POST', CANCELLATION_AUTHORITY_PATH, timestamp,
        createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest('hex');
}
