/**
 * C-6 host enrollment, app side (docs/AWS-COMPUTERS.md C-6; pinned wire
 * contract reports/2026-10-14-aws-azure-first-lead/GATEWAY-CONTRACT-v1.md).
 *
 * 1. Issue (this file, used by `aws-ec2.ts`): every boot that launches or
 *    starts an instance gets 32 random bytes. Only their sha256 and a deadline
 *    (≤10 min) are stored on the placement, in the SAME write as the lease or
 *    the creation. The plaintext travels once, in the launch's user data,
 *    which is readable on that host only.
 * 2. Enroll (`handleAwsEnrollment` below): the host presents the nonce with its
 *    signed identity document; every check passes or nothing changes.
 *
 * 🔴 Never log a nonce, a control key or a tunnel token.
 */

import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

/** C-6: at most 10 minutes between issue and enrollment. */
export const ENROLL_NONCE_TTL_SECONDS = 600;

/** Host `lease.py` NONCE_RE: base64url, 32-128 characters. 32 bytes → 43. */
const NONCE_RE = /^[A-Za-z0-9_-]{32,128}$/;

export interface EnrollmentNonce {
    /** Plaintext: goes into the launch user data only. */
    nonce: string;
    /** sha256(nonce) in hex: the only form the database ever holds. */
    nonceHash: string;
    expiresAt: Date;
}

export const nonceHashOf = (nonce: string): string => createHash('sha256').update(nonce, 'utf8').digest('hex');

export function issueEnrollmentNonce(now: Date, random: (n: number) => Buffer = nodeRandomBytes): EnrollmentNonce {
    const bytes = random(32);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 32) throw new Error('enrollment nonce needs 32 random bytes');
    const nonce = bytes.toString('base64url');
    return { nonce, nonceHash: nonceHashOf(nonce), expiresAt: new Date(now.getTime() + ENROLL_NONCE_TTL_SECONDS * 1000) };
}

/** The lifecycle intent's `userData` limit (base64 characters). */
export const USER_DATA_MAX = 4096;

export interface EnrollmentUserDataInput {
    computerId: string;
    /** null on a provision: the data volume does not exist yet when the intent is built. */
    volumeId: string | null;
    fsUuid: string;
    generation: number;
    leaseEpoch: number;
    nonce: string;
    /** True only for the computer's first boot (the host may create the filesystem). */
    provision: boolean;
    enrollUrl: string;
}

export class EnrollmentUserDataError extends Error {
    constructor(reason: string) {
        super(`enrollment_user_data_invalid:${reason}`);
        this.name = 'EnrollmentUserDataError';
    }
}

/**
 * Base64 of the host lease JSON (`infra/host-agent/lib/ezil_host/lease.py`):
 * `{v, computerId, volumeId, fsUuid, generation, leaseEpoch, nonce, provision}`,
 * plus the contract's `enrollUrl` (the host reads its URL from the AMI's
 * agent.json; the field is informational and ignored by `lease.parse`).
 * Key order is fixed: the document is digest-pinned through the intent.
 */
export function buildEnrollmentUserData(i: EnrollmentUserDataInput): string {
    if (!NONCE_RE.test(i.nonce)) throw new EnrollmentUserDataError('nonce');
    if (!Number.isSafeInteger(i.generation) || i.generation < 1) throw new EnrollmentUserDataError('generation');
    if (!Number.isSafeInteger(i.leaseEpoch) || i.leaseEpoch < 1) throw new EnrollmentUserDataError('leaseEpoch');
    if (i.provision !== (i.volumeId === null)) throw new EnrollmentUserDataError('volumeId');
    const lease = {
        v: 1,
        computerId: i.computerId.toLowerCase(),
        ...(i.volumeId === null ? {} : { volumeId: i.volumeId }),
        fsUuid: i.fsUuid.toLowerCase(),
        generation: i.generation,
        leaseEpoch: i.leaseEpoch,
        nonce: i.nonce,
        provision: i.provision,
        enrollUrl: i.enrollUrl,
    };
    const encoded = Buffer.from(JSON.stringify(lease), 'utf8').toString('base64');
    if (encoded.length > USER_DATA_MAX) throw new EnrollmentUserDataError('too_large');
    return encoded;
}
