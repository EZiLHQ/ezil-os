import { z } from 'zod';
import { createHash } from 'node:crypto';
import { LifecycleDeploymentSchema } from './deployment.js';
import { PreparationReferenceSchema } from './lease.js';
import { COUNTER, DIGEST, HASH, SNAP, TIME, UUID, VOL, strictJson } from './strict-json.js';
import { RecordedErrorSchema, NO_ERROR } from './errors.js';
import { EnvelopeSchema, SettingsSchema } from './contract.js';

export const RecoverySettingsSchema = z.object({
    lifecycle: SettingsSchema,
    recoveryVersionArn: z.string(),
}).strict().superRefine((s, ctx) => {
    const d = s.lifecycle.deployment;
    if (d.recoveryStateMachineVersionArn && s.recoveryVersionArn !== d.recoveryStateMachineVersionArn)
        ctx.addIssue({ code: 'custom', message: 'recovery_version_mismatch' });
    if (!new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`).test(s.recoveryVersionArn)
        || machineArn(s.recoveryVersionArn) === machineArn(d.stateMachineVersionArn)
        || !machineArn(s.recoveryVersionArn).split(':').at(-1)!.startsWith(`ezil-${d.namespace}-`)) {
        ctx.addIssue({ code: 'custom', message: 'invalid_recovery_settings' });
    }
});
export const machineArn = (version: string) => version.slice(0, version.lastIndexOf(':'));
export type RecoverySettings = z.infer<typeof RecoverySettingsSchema>;
export const CleanupRecoveryInputSchema = z.object({ sourceExecutionArn: z.string().max(300) }).strict();
export const recoveryPhases = ['initial', 'old-stopped', 'old-terminated', 'target-stopped', 'target-terminated'] as const;
export type RecoveryPhase = typeof recoveryPhases[number];
export interface RecoveryReceipt {
    schemaVersion: 1;
    sourceExecutionArn: string;
    jobId: string;
    digest: string;
    computerId: string;
    state: 'fenced';
    volumeId: string | null;
    instances: { instanceId: string; generation: number; fenceToken: string; state: 'terminated' }[];
}

export const ImageRecoveryDocumentSchema = z.object({
    schemaVersion: z.literal(1), jobId: UUID, imageJobId: UUID, sourceExecutionArn: z.string().max(300),
    rebasePreparation: PreparationReferenceSchema, computerId: UUID, originalVolumeId: VOL, fsUuid: UUID,
    sourceGeneration: COUNTER, sourceLeaseEpoch: COUNTER, sourceFenceToken: UUID, fromDigest: DIGEST,
    snapshotId: SNAP, deployment: LifecycleDeploymentSchema, createdAt: TIME,
}).strict().superRefine((i, ctx) => {
    const d = i.deployment, preparation = d.preparationStateMachineVersionArn;
    if (!d.lowerImageDigest || d.lowerImageDigest !== i.fromDigest || !preparation || !d.recoveryStateMachineVersionArn
        || i.jobId === i.imageJobId || i.rebasePreparation.preparationJobId !== i.imageJobId
        || i.rebasePreparation.executionArn !== machineArn(preparation).replace(':stateMachine:', ':execution:') + ':computer-' + i.imageJobId
        || !new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:execution:ezil-${d.namespace}-[A-Za-z0-9_-]+:computer-[0-9a-f-]{36}$`).test(i.sourceExecutionArn))
        ctx.addIssue({ code: 'custom', message: 'restore_lineage_mismatch' });
});
export type ImageRecoveryDocument = z.infer<typeof ImageRecoveryDocumentSchema>;
export const ImageRecoveryReceiptSchema = z.object({
    schemaVersion: z.literal(1), jobId: UUID, digest: HASH, imageJobId: UUID, state: z.literal('restore_volume_ready'),
    sourceExecutionArn: z.string().max(300), snapshotId: SNAP, originalVolumeId: VOL, volumeId: VOL, fsUuid: UUID,
    sourceGeneration: COUNTER, sourceLeaseEpoch: COUNTER, sourceFenceToken: UUID, fromDigest: DIGEST, verifiedAt: TIME,
}).strict();
export type ImageRecoveryReceipt = z.infer<typeof ImageRecoveryReceiptSchema>;
export const ImageRecoveryControlSchema = z.object({ fencedAt: TIME.nullable(), volumeId: VOL.nullable(),
    createAttempted: z.boolean(), lastError: RecordedErrorSchema }).strict();
export const imageRecoveryControl = { fencedAt: null, volumeId: null, createAttempted: false, lastError: NO_ERROR };
export const imageRecoveryPhases = [...recoveryPhases, 'volume'] as const;
export const ImageRecoveryEventSchema = z.object({ mode: z.literal('image'), executionArn: z.string().max(300),
    phase: z.enum(imageRecoveryPhases), control: ImageRecoveryControlSchema }).strict();
export const RecoveryInputSchema = z.union([CleanupRecoveryInputSchema, EnvelopeSchema]);
export function parseImageRecoveryInput(raw: string) {
    const envelope = EnvelopeSchema.parse(strictJson(raw, 20000));
    if (createHash('sha256').update(envelope.document, 'utf8').digest('hex') !== envelope.digest) throw new Error('restore_failed');
    const document = ImageRecoveryDocumentSchema.parse(strictJson(envelope.document, 16384));
    if (JSON.stringify(document) !== envelope.document) throw new Error('restore_failed');
    return { envelope, document };
}
export const restoreToken = (i: Pick<ImageRecoveryDocument, 'jobId' | 'snapshotId'>) =>
    createHash('sha256').update(`ezil-ebs-restore-v1\n${i.jobId}\n${i.snapshotId}`, 'utf8').digest('hex');
export const restoreTags = (i: ImageRecoveryDocument) => ({
    'ezil:managed-by': 'app-computer-platform', 'ezil:stage': i.deployment.namespace, 'ezil:computer-id': i.computerId,
    'ezil:generation': String(i.sourceGeneration), 'ezil:fence-token': i.sourceFenceToken, 'ezil:backup': i.deployment.namespace,
    'ezil:restored-from-snapshot': i.snapshotId, 'ezil:original-volume-id': i.originalVolumeId, 'ezil:recovery-job-id': i.jobId,
});
export const recoveryAuthority = (i: ImageRecoveryDocument, digest: string) => ({ schemaVersion: 1,
    computerId: i.computerId, jobId: i.jobId, leaseEpoch: i.sourceLeaseEpoch, digest,
    imageJobId: i.imageJobId, imageJobPhase: 'recovery' as const });
