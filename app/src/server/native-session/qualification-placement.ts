import { createHmac } from 'node:crypto';

import { deriveControlKey } from '@/server/lib/compute/aws-control-key';
import { readPlacement, type PlacementExecutor } from '@/server/lib/compute/placement';
import { nativeDeploymentSha256, nativePolicyCanonical } from './accepted-policy';
import { nativeComputerOwnedNow } from './authority';

export const NATIVE_QUALIFICATION_MAX_MS = 300_000;
const CLOCK_SKEW_MS = 5_000;
const QUALIFICATION_DOMAIN = 'ezil-native-qualification-placement-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const PROFILE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const counter = (value: unknown): value is string => matches(value, /^[1-9][0-9]{0,9}$/) && Number(value) <= 2147483647;
const fields = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export interface QualificationPlacementChallenge {
    v: 1;
    computerId: string;
    bootId: string;
    placement: { generation: string; leaseEpoch: string; instanceId: string };
    profileDigest: string;
    manifestSha256: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
}

export interface QualificationPlacementReceipt extends Omit<QualificationPlacementChallenge, 'placement'> {
    ownerUserId: string;
    placement: QualificationPlacementChallenge['placement'] & { fenceToken: string };
}

function timestamp(value: unknown): number | null {
    if (!matches(value, ISO_MS)) return null;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}

function parseChallenge(bytes: string): QualificationPlacementChallenge {
    const fail = () => new Error('qualification_challenge_invalid');
    if (Buffer.byteLength(bytes, 'utf8') > 4096) throw fail();
    let value: unknown;
    try { value = JSON.parse(bytes) as unknown; } catch { throw fail(); }
    if (!fields(value, ['v', 'computerId', 'bootId', 'placement', 'profileDigest', 'manifestSha256', 'nonce', 'issuedAt', 'expiresAt'])
        || value.v !== 1 || !matches(value.computerId, UUID) || !matches(value.bootId, UUID)
        || !fields(value.placement, ['generation', 'leaseEpoch', 'instanceId'])
        || !counter(value.placement.generation) || !counter(value.placement.leaseEpoch) || !matches(value.placement.instanceId, INSTANCE)
        || !matches(value.profileDigest, PROFILE_DIGEST) || !matches(value.manifestSha256, HEX) || !matches(value.nonce, NONCE)
        || Buffer.from(value.nonce, 'base64url').toString('base64url') !== value.nonce || nativePolicyCanonical(value) !== bytes) {
        throw fail();
    }
    const issued = timestamp(value.issuedAt), expires = timestamp(value.expiresAt);
    if (issued === null || expires === null || expires <= issued || expires - issued > NATIVE_QUALIFICATION_MAX_MS) throw fail();
    return value as unknown as QualificationPlacementChallenge;
}

function assertLive(challenge: QualificationPlacementChallenge, now: number): void {
    if (!Number.isFinite(now) || Date.parse(challenge.issuedAt) > now + CLOCK_SKEW_MS || Date.parse(challenge.expiresAt) <= now) {
        throw new Error('qualification_challenge_expired');
    }
}

interface SignOptions {
    db: PlacementExecutor;
    now: () => Date;
    controlSecret: string;
    target: { computerId: string; ownerUserId: string; instanceId: string };
    deployment: { hostPolicyDigest: string; artifactManifestSha256: string };
}

/** One-shot operator invocation through a read-only DB snapshot; qualification only, no authority or grant mint. */
export async function signNativeQualificationPlacement(bytes: string, options: SignOptions): Promise<{
    receipt: QualificationPlacementReceipt; signature: string;
}> {
    const challenge = parseChallenge(bytes);
    const { db, target, deployment } = options;
    const controlSecret = options.controlSecret.trim();
    assertLive(challenge, options.now().getTime());
    if (!controlSecret || !matches(target.computerId, UUID) || !matches(target.ownerUserId, UUID) || !matches(target.instanceId, INSTANCE)
        || !matches(deployment.hostPolicyDigest, PROFILE_DIGEST) || !matches(deployment.artifactManifestSha256, HEX)) {
        throw new Error('qualification_configuration_invalid');
    }
    if (target.computerId !== challenge.computerId || target.instanceId !== challenge.placement.instanceId
        || deployment.hostPolicyDigest !== challenge.profileDigest || deployment.artifactManifestSha256 !== challenge.manifestSha256) {
        throw new Error('qualification_target_mismatch');
    }

    // Both the live computer row and the canonical placement must identify the separately pinned owner.
    if (!await nativeComputerOwnedNow(db, target.ownerUserId, target.computerId)) throw new Error('qualification_owner_mismatch');
    const { record: p } = await readPlacement(db, target.computerId, target.ownerUserId);
    if (!p || p.provider !== 'aws-ec2' || p.state !== 'RUNNING' || p.computerId !== target.computerId || p.ownerUserId !== target.ownerUserId
        || p.instanceId !== target.instanceId || String(p.generation) !== challenge.placement.generation
        || String(p.leaseEpoch) !== challenge.placement.leaseEpoch || !matches(p.fenceToken, UUID)
        || !matches(p.enrollConsumedHash, HEX) || !p.leaseUntil) {
        throw new Error('qualification_placement_mismatch');
    }
    const now = options.now().getTime();
    assertLive(challenge, now);
    const issued = Math.max(now, Date.parse(challenge.issuedAt));
    const expires = Math.min(Date.parse(challenge.expiresAt), p.leaseUntil.getTime(), issued + NATIVE_QUALIFICATION_MAX_MS);
    if (!Number.isFinite(expires) || expires <= issued) throw new Error('qualification_lease_expired');

    const receipt: QualificationPlacementReceipt = {
        v: 1, computerId: p.computerId, ownerUserId: p.ownerUserId, bootId: challenge.bootId,
        placement: { generation: String(p.generation), leaseEpoch: String(p.leaseEpoch), instanceId: p.instanceId, fenceToken: p.fenceToken },
        profileDigest: deployment.hostPolicyDigest, manifestSha256: deployment.artifactManifestSha256,
        nonce: challenge.nonce, issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString(),
    };
    const key = deriveControlKey(controlSecret, {
        computerId: p.computerId, generation: p.generation, leaseEpoch: p.leaseEpoch, nonceHash: p.enrollConsumedHash,
    });
    try {
        const digest = nativeDeploymentSha256(nativePolicyCanonical(receipt));
        const signature = 'v1=' + createHmac('sha256', key).update(QUALIFICATION_DOMAIN + '|' + digest, 'ascii').digest('hex');
        return { receipt, signature };
    } finally { key.fill(0); }
}
