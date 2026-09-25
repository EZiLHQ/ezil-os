import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EnvelopeSchema, SettingsSchema } from './contract.js';
import { machineArn, recoveryPhases } from './recovery-contract.js';
import { parseComputerLifecycleWork } from './computer-recovery.js';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/), digest = z.string().regex(/^[a-f0-9]{64}$/);
export const CANCELLATION_PATH = '/api/internal/computers/cancellation-authority';
export const CancellationSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('cancel'),
    cancellationId: uuid, computerId: uuid, source: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]),
        jobId: uuid, digest, stateAtRequest: z.enum(['queued', 'running']) }).strict(),
    reason: z.enum(['stop_requested', 'authority_revoked']), requestedBy: uuid.nullable(), workflowVersionArn: z.string(),
}).strict().refine(c => (c.reason === 'stop_requested') === (c.requestedBy !== null));
export type Cancellation = z.infer<typeof CancellationSchema>;
export const CancellationInputSchema = z.object({ schemaVersion: z.literal(1), document: z.string().max(4096), digest,
    source: EnvelopeSchema }).strict();
export const CancellationScopeSchema = z.object({ source: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), jobId: uuid, digest }).strict(),
    dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/).nullable(), writers: z.array(z.object({
        instanceId: z.string().regex(/^i-[a-f0-9]{17}$/), generation: z.number().int().min(1).max(2147483647), fenceToken: uuid,
        observedState: z.enum(['pending', 'starting', 'running', 'stopping', 'stopped', 'failed']),
        observedAt: z.string().datetime().nullable(), fencedAt: z.string().datetime().nullable(),
    }).strict()).max(128).refine(rows => new Set(rows.map(r => r.instanceId)).size === rows.length
        && new Set(rows.map(r => r.generation)).size === rows.length) }).strict();
export type CancellationScope = z.infer<typeof CancellationScopeSchema>;
export const cancellationAuthorityFor = (c: Cancellation, digest: string) => ({ schemaVersion: 1, computerId: c.computerId, cancellationId: c.cancellationId, digest });
export const CancellationSettingsSchema = z.object({ lifecycle: SettingsSchema, cancellationVersionArn: z.string(),
    cancellationSecretArn: z.string() }).strict().superRefine((s, ctx) => {
    const account = s.lifecycle.deployment.accountId;
    if (!new RegExp(`^arn:aws:states:us-east-1:${account}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`).test(s.cancellationVersionArn)
        || machineArn(s.cancellationVersionArn) === machineArn(s.lifecycle.deployment.stateMachineVersionArn)
        || !new RegExp(`^arn:aws:secretsmanager:us-east-1:${account}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`).test(s.cancellationSecretArn)
        || s.cancellationSecretArn === s.lifecycle.authoritySecretArn) ctx.addIssue({ code: 'custom', message: 'invalid_cancellation_settings' });
});
export type CancellationSettings = z.infer<typeof CancellationSettingsSchema>;
export const cancellationPhases = ['initial', 'source-interrupted', ...recoveryPhases.slice(1)] as const;
export function parseCancellationInput(value: unknown, sourceCreatedAt: Date) {
    const envelope = CancellationInputSchema.parse(value);
    if (Buffer.byteLength(envelope.document) > 4096 || createHash('sha256').update(envelope.document).digest('hex') !== envelope.digest) throw new Error('cancellation_invalid');
    const cancellation = CancellationSchema.parse(JSON.parse(envelope.document));
    const intent = parseComputerLifecycleWork({ ...envelope.source, createdAt: sourceCreatedAt });
    if (cancellation.source.schemaVersion !== intent.schemaVersion || envelope.source.schemaVersion !== intent.schemaVersion
        || cancellation.source.jobId !== intent.jobId || cancellation.source.digest !== envelope.source.digest
        || cancellation.computerId !== intent.computerId || !['provision', 'start', 'replace', 'recover'].includes(intent.operation)) throw new Error('cancellation_invalid');
    return { envelope, cancellation, intent };
}
