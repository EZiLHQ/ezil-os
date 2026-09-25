import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
export const ComputerCancellationV1Schema = z.object({ schemaVersion: z.literal(1), operation: z.literal('cancel'),
    cancellationId: uuid, computerId: uuid,
    source: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), jobId: uuid,
        digest: z.string().regex(/^[a-f0-9]{64}$/), stateAtRequest: z.enum(['queued', 'running']) }).strict(),
    reason: z.enum(['stop_requested', 'authority_revoked']), requestedBy: uuid.nullable(),
    workflowVersionArn: z.string().regex(/^arn:aws:states:us-east-1:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/),
}).strict().refine(c => (c.reason === 'stop_requested') === (c.requestedBy !== null));
export type ComputerCancellationV1 = z.infer<typeof ComputerCancellationV1Schema>;

/** Parses both immutable documents and verifies scope; it does not authorize a
 * caller, infer revocation, stop a workflow, or certify provider fencing. */
export function parseComputerCancellation(work: LifecycleWork, source: LifecycleWork): ComputerCancellationV1 {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 4096
            || !/^[a-f0-9]{64}$/.test(work.digest) || !(work.createdAt instanceof Date) || !Number.isFinite(work.createdAt.getTime())
            || createHash('sha256').update(work.document).digest('hex') !== work.digest) throw new Error();
        const c = ComputerCancellationV1Schema.parse(JSON.parse(work.document)), i = parseComputerLifecycleWork(source);
        const workflow = c.workflowVersionArn.split(':');
        if (c.computerId !== i.computerId || c.source.jobId !== i.jobId || c.source.schemaVersion !== i.schemaVersion
            || c.source.digest !== source.digest || !['provision', 'start', 'replace', 'recover'].includes(i.operation)
            || workflow[4] !== i.deployment.accountId
            || c.workflowVersionArn.slice(0, c.workflowVersionArn.lastIndexOf(':')) === i.deployment.stateMachineVersionArn.slice(0, i.deployment.stateMachineVersionArn.lastIndexOf(':'))) throw new Error();
        return c;
    } catch { throw new LifecycleError('lifecycle_invalid'); }
}
