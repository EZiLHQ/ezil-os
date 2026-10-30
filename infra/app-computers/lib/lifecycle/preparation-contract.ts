import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, SourceLifecycleDeploymentSchema } from './deployment.js';
import { COUNTER, DIGEST, HASH, INSTANCE, SNAP, TIME, UUID, VOL, strictJson } from './strict-json.js';
import { EnvelopeSchema } from './contract.js';

export const REBASE_PREPARATION_TIMEOUT_SECONDS = 7200;
export const PreparationDocumentSchema = z.object({
    schemaVersion: z.literal(1), jobId: UUID, computerId: UUID, sourceInstanceId: INSTANCE,
    sourceVolumeId: VOL, fsUuid: UUID, sourceGeneration: COUNTER, sourceLeaseEpoch: COUNTER,
    sourceFenceToken: UUID, fromDigest: DIGEST, toDigest: DIGEST, volumeGiB: z.number().int().min(1).max(16384),
    sourceDeployment: SourceLifecycleDeploymentSchema, deployment: LifecycleDeploymentSchema, createdAt: TIME,
}).strict().superRefine((i, ctx) => {
    const d = i.deployment, s = i.sourceDeployment;
    if (i.fromDigest !== s.lowerImageDigest || i.fromDigest !== d.previousLowerImageDigest || i.toDigest !== d.lowerImageDigest
        || i.fromDigest === i.toDigest || i.volumeGiB < d.storage.dataMinGiB || i.volumeGiB > d.storage.dataMaxGiB
        || (['accountId', 'region', 'namespace', 'zoneId', 'dataKeyArn'] as const).some(k => s[k] !== d[k]))
        ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
});
export type PreparationDocument = z.infer<typeof PreparationDocumentSchema>;
export const PreparationReceiptSchema = z.object({
    schemaVersion: z.literal(1), jobId: UUID, digest: HASH, computerId: UUID, state: z.literal('snapshot_ready'),
    sourceInstanceId: INSTANCE, sourceVolumeId: VOL, fsUuid: UUID, sourceGeneration: COUNTER,
    sourceLeaseEpoch: COUNTER, sourceFenceToken: UUID, fromDigest: DIGEST, toDigest: DIGEST,
    snapshotId: SNAP, snapshotOwnerId: z.string().regex(/^[0-9]{12}$/), snapshotVolumeGiB: z.number().int().min(1).max(16384),
    snapshotKmsKeyArn: z.string().max(300), fencedAt: TIME, snapshotStartedAt: TIME, snapshotCompletedAt: TIME, verifiedAt: TIME,
}).strict();
export type PreparationReceipt = z.infer<typeof PreparationReceiptSchema>;
export const preparationTags = (i: PreparationDocument) => ({
    'ezil:managed-by': 'app-computer-platform', 'ezil:stage': i.deployment.namespace,
    'ezil:computer-id': i.computerId, 'ezil:source-volume-id': i.sourceVolumeId,
    'ezil:source-generation': String(i.sourceGeneration), 'ezil:source-fence-token': i.sourceFenceToken,
    'ezil:preparation-job-id': i.jobId, 'ezil:purpose': 'pre-rebase',
});
export const SNAPSHOT_TAG_KEYS = ['ezil:managed-by', 'ezil:stage', 'ezil:computer-id', 'ezil:source-volume-id',
    'ezil:source-generation', 'ezil:source-fence-token', 'ezil:preparation-job-id', 'ezil:purpose'] as const;
export const preparationSourceTags = (i: PreparationDocument) => ({ 'ezil:managed-by': 'app-computer-platform',
    'ezil:stage': i.deployment.namespace, 'ezil:computer-id': i.computerId, 'ezil:generation': String(i.sourceGeneration),
    'ezil:fence-token': i.sourceFenceToken, 'ezil:backup': i.deployment.namespace });
export const preparationAuthority = (i: PreparationDocument, digest: string) => ({ schemaVersion: 1, computerId: i.computerId,
    jobId: i.jobId, leaseEpoch: i.sourceLeaseEpoch, digest, imageJobId: i.jobId, imageJobPhase: 'preparation' as const });
export function parsePreparationInput(raw: string) {
    const envelope = EnvelopeSchema.parse(strictJson(raw, 20000));
    if (createHash('sha256').update(envelope.document, 'utf8').digest('hex') !== envelope.digest) throw new Error('preparation_failed');
    const document = PreparationDocumentSchema.parse(strictJson(envelope.document, 16384));
    if (JSON.stringify(document) !== envelope.document) throw new Error('preparation_failed');
    return { envelope, document };
}
