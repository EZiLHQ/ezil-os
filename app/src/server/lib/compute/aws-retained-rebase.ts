import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readAwsEnrollUrl, type Env } from './aws-config';
import { parseRebaseJson, RebaseCounter, RebaseDigest, RebaseHash, RebaseUuid } from './aws-rebase-json';
import type { ImagePlacement } from './placement';
import { rebaseManifestSha256, type RebaseRelease } from './aws-rebase-release';

const ApprovalSchema = z.object({
    schemaVersion: z.literal(1),
    computerId: RebaseUuid,
    ownerUserId: RebaseUuid,
    sourceGeneration: RebaseCounter,
    sourceLeaseEpoch: RebaseCounter,
    sourceFenceToken: RebaseUuid,
    sourceLowerDigest: RebaseDigest,
    activeManifestSha256: RebaseHash,
    retainedManifestSha256: RebaseHash,
    interveningManifestSha256: RebaseHash.optional(),
}).strict();

export function readRetainedRebaseApproval(env: Env, placement: ImagePlacement, sha256: string) {
    if (readAwsEnrollUrl(env) !== 'https://os-staging.ezil.work/api/compute/aws/enroll'
        || placement.state !== 'STOPPED' || placement.lifecycleJobId) throw new Error('operator_required');

    let raw: unknown;
    try { raw = parseRebaseJson(env.EZIL_AWS_RETAINED_REBASE_APPROVAL ?? '', 4096); }
    catch { throw new Error('operator_required'); }
    const parsed = ApprovalSchema.safeParse(raw);
    if (!parsed.success) throw new Error('operator_required');
    const approval = parsed.data;
    if (approval.computerId !== placement.computerId || approval.ownerUserId !== placement.ownerUserId
        || approval.sourceGeneration !== placement.generation || approval.sourceLeaseEpoch !== placement.leaseEpoch
        || approval.sourceFenceToken !== placement.fenceToken || approval.sourceLowerDigest !== placement.lowerImageDigest
        || approval.retainedManifestSha256 !== sha256) throw new Error('operator_required');
    return approval;
}

interface SourceAllocation {
    computerId: string;
    sourceGeneration: number;
    sourceLeaseEpoch: number;
    sourceFenceToken: string;
}

/** Preserve the signed-only classification after config rotation without a new job column. */
export function retainedRebaseJobId(source: SourceAllocation, sha256: string): string {
    const hex = createHash('sha256').update(JSON.stringify([
        'aws-image-retained-operator-hop-v1', source.computerId, source.sourceGeneration,
        source.sourceLeaseEpoch, source.sourceFenceToken, sha256,
    ])).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-b${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isRetainedRebaseJob(job: SourceAllocation & { jobId: string; targetRelease: RebaseRelease }): boolean {
    return job.jobId === retainedRebaseJobId(job, rebaseManifestSha256(job.targetRelease));
}
