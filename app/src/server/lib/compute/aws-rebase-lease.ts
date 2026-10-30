import { z } from 'zod';
import { readAwsEnrollUrl } from './aws-config';
import { parseRebaseJson, RebaseCounter, RebaseDigest, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume } from './aws-rebase-json';

export const REBASE_ENROLL_RESERVE_SECONDS = 120;
export const REBASE_CLOCK_SKEW_SECONDS = 30;
export const REBASE_PREPARATION_TIMEOUT_SECONDS = 7200;
export const REBASE_SNAPSHOT_RETENTION_SECONDS = 604800;
export const ENROLL_NONCE_TTL_SECONDS = 600;
export const USER_DATA_MAX = 4096;

export const RebaseSchema = z.object({ snapshotId: RebaseSnapshot, volumeId: RebaseVolume, fromDigest: RebaseDigest, toDigest: RebaseDigest }).strict();
export const RebasePermitSchema = z.object({
    v: z.literal(1), preparationJobId: RebaseUuid, launchJobId: RebaseUuid, computerId: RebaseUuid, fsUuid: RebaseUuid,
    generation: RebaseCounter, leaseEpoch: RebaseCounter, fenceToken: RebaseUuid, issuedAt: RebaseTime, expiresAt: RebaseTime,
}).strict();
export const EbsRestoreSchema = z.object({
    v: z.literal(1), preparationJobId: RebaseUuid, recoveryJobId: RebaseUuid, launchJobId: RebaseUuid,
    snapshotId: RebaseSnapshot, originalVolumeId: RebaseVolume, volumeId: RebaseVolume, computerId: RebaseUuid, fsUuid: RebaseUuid,
    fromDigest: RebaseDigest, sourceGeneration: RebaseCounter, sourceLeaseEpoch: RebaseCounter,
    generation: RebaseCounter, leaseEpoch: RebaseCounter, fenceToken: RebaseUuid,
    issuedAt: RebaseTime, expiresAt: RebaseTime, maintenance: z.literal(true),
}).strict();
export type RebasePermit = z.infer<typeof RebasePermitSchema>;
export type EbsRestore = z.infer<typeof EbsRestoreSchema>;

const RestoreSchema = z.object({
    kind: z.literal('cf-snapshot'), migrationId: RebaseUuid, generation: RebaseUuid,
    fetchBase: z.string(), identityToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), system: z.boolean(),
}).strict();

/** Field declaration order is the serializer and hash contract. */
export const EnrollmentLeaseSchema = z.object({
    v: z.literal(1), computerId: RebaseUuid, volumeId: RebaseVolume.optional(), fsUuid: RebaseUuid,
    generation: RebaseCounter, leaseEpoch: RebaseCounter, nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    provision: z.boolean(), enrollUrl: z.string().max(512).regex(/^[\x20-\x7e]+$/)
        .refine((url) => readAwsEnrollUrl({ EZIL_AWS_ENROLL_URL: url }) === url),
    restore: RestoreSchema.optional(), rebase: RebaseSchema.optional(), rebasePermit: RebasePermitSchema.optional(), ebsRestore: EbsRestoreSchema.optional(),
}).strict().superRefine((l, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'permit_invalid' });
    if (l.provision !== (l.volumeId === undefined)) fail();
    if (!!l.rebase !== !!l.rebasePermit) fail();
    if ([l.restore, l.rebase, l.ebsRestore].filter((x) => x !== undefined).length > 1) fail();
    if (l.restore) {
        try {
            const u = new URL(l.restore.fetchBase);
            if (!l.provision || !['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash
                || u.pathname !== `/api/compute/restore/${l.computerId}`) fail();
        } catch { fail(); }
    }
    const permit = l.rebasePermit ?? l.ebsRestore;
    if (permit) {
        if (l.provision || permit.computerId !== l.computerId || permit.fsUuid !== l.fsUuid || permit.generation !== l.generation
            || permit.leaseEpoch !== l.leaseEpoch || permit.preparationJobId === permit.launchJobId
            || Date.parse(permit.expiresAt) - Date.parse(permit.issuedAt) !== ENROLL_NONCE_TTL_SECONDS * 1000) fail();
    }
    if (l.rebase && (l.rebase.volumeId !== l.volumeId || l.rebase.fromDigest === l.rebase.toDigest)) fail();
    if (l.ebsRestore && (l.ebsRestore.volumeId !== l.volumeId || l.ebsRestore.originalVolumeId === l.volumeId
        || l.ebsRestore.generation <= l.ebsRestore.sourceGeneration || l.ebsRestore.leaseEpoch <= l.ebsRestore.sourceLeaseEpoch
        || l.ebsRestore.recoveryJobId === l.ebsRestore.launchJobId || l.ebsRestore.recoveryJobId === l.ebsRestore.preparationJobId)) fail();
});
export type EnrollmentLease = z.infer<typeof EnrollmentLeaseSchema>;

/** Parsing a completed reboot's authorization deliberately does not enforce current expiry. */
export function parseEnrollmentUserData(encoded: string): EnrollmentLease {
    if (typeof encoded !== 'string' || encoded.length > USER_DATA_MAX || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('permit_invalid');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > 3072 || bytes.toString('base64') !== encoded) throw new Error('permit_invalid');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return EnrollmentLeaseSchema.parse(parseRebaseJson(text, 3072));
}

/** Rechecked immediately before issuing/starting a digest-changing operation. */
export function rebaseRemainingBudget(permit: Pick<RebasePermit, 'issuedAt' | 'expiresAt'>, now: Date): number {
    const issued = RebaseTime.parse(permit.issuedAt), expires = RebaseTime.parse(permit.expiresAt);
    if (!Number.isFinite(now.getTime()) || Date.parse(expires) - Date.parse(issued) !== ENROLL_NONCE_TTL_SECONDS * 1000
        || Date.parse(issued) > now.getTime() + REBASE_CLOCK_SKEW_SECONDS * 1000) throw new Error('permit_invalid');
    const remaining = Date.parse(expires) - now.getTime();
    if (remaining <= 0) throw new Error('permit_expired');
    if (remaining <= REBASE_ENROLL_RESERVE_SECONDS * 1000) throw new Error('enrollment_time_insufficient');
    return remaining - REBASE_ENROLL_RESERVE_SECONDS * 1000;
}
