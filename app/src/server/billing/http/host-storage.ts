import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { isAwsComputersEnabled, type Env } from '@/server/lib/compute/aws-config';
import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import { parseRebaseJson } from '@/server/lib/compute/aws-rebase-json';
import { RUNNING_CLASS_STATES, type Placement } from '@/server/lib/compute/placement';
import type { StorageSample } from '../ports';
import { readBillingBody } from './stripe-webhook';

/**
 * `POST /api/compute/aws/storage`: an AWS computer's host agent reports the used bytes of the
 * computer's retained data volume (statvfs, measured OUTSIDE the guest container), every 15 min
 * and on stop (infra/host-agent `storage.py`; docs/billing/CONTRACT.md §3.2).
 *
 * The credential is the epoch's control key, the one the app already issued to this host at
 * enrollment (aws-enroll.ts `deriveControlKey`, stored host-only in `stateDir/control.key`). The
 * app re-derives it from the placement's consumed-nonce proof, so nothing new is stored, and the
 * key never enters the guest (users are root there). No deployment-wide secret is ever trusted
 * for a computer id: the signed headers only SELECT a key, the key proves them, and the owner comes
 * from the placement (C-2), never from `ezil_computers` or the body. The body carries no ids at
 * all (strict schema: a body that names a computer or user is refused).
 *
 *   X-Ezil-Computer-Id, X-Ezil-Generation, X-Ezil-Lease-Epoch: the epoch the host enrolled
 *   X-Ezil-Timestamp: unix seconds, within ±300 s
 *   X-Ezil-Signature: v1=<hex HMAC-SHA256(controlKey, `${STORAGE_MAC_INFO}|ts|computerId|generation|leaseEpoch|sha256hex(body)`)>
 *   body: {"bytes":"<decimal>","measuredAt":"<RFC 3339>","reason":"interval"|"stop"}
 *
 * The proof exists from enrollment until the placement starts DRAINING or RETIRING (both clear
 * it), so a sample sent after a control-plane stop began is refused; the last periodic sample
 * stands. Idempotent per (computer, measuredAt): a retry is `recorded: false`.
 * 🔴 Never logs or echoes the signature, the derived key or the nonce hash.
 */
export const STORAGE_MAC_INFO = 'ezil-storage-sample-v1';
/** The signature's freshness window, as the usage ingest's. */
export const STORAGE_SIGNATURE_SKEW_SECONDS = 300;
/** Two sampling intervals: an older measurement is stale (the host measures again instead). */
export const STORAGE_SAMPLE_MAX_AGE_MS = 30 * 60_000;
/** A host clock slightly ahead is tolerated, as the usage ingest's `latestAllowed`. */
export const STORAGE_SAMPLE_MAX_FUTURE_MS = 5 * 60_000;
export const STORAGE_SAMPLE_SOURCE = 'host-agent';
const MAX_BODY_BYTES = 4096;
const INT8_MAX = BigInt('9223372036854775807');
const NO_STORE = { 'cache-control': 'no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER = /^[1-9]\d{0,9}$/;
const HEX64 = /^[a-f0-9]{64}$/;

const bodySchema = z.object({
    bytes: z.string().regex(/^(0|[1-9]\d{0,18})$/),
    measuredAt: z.string().datetime({ offset: true }),
    reason: z.enum(['interval', 'stop']),
}).strict();

export interface HostStorageDeps {
    env: Env;
    now(): Date;
    /** The computer's placement record (placement.ts `readPlacement`), null without one. */
    placement(computerId: string): Promise<Placement | null>;
    record(userId: string, sample: StorageSample & { source: string }): Promise<'recorded' | 'duplicate'>;
}

const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: NO_STORE });
/** One answer for every unauthenticated case, so the endpoint is no oracle for computers or epochs. */
const unauthenticated = () => answer(401, { error: 'storage_unauthenticated' });

export function storageMacMessage(input: { timestamp: string; computerId: string; generation: number; leaseEpoch: number; body: string }): string {
    const digest = createHash('sha256').update(input.body, 'utf8').digest('hex');
    return [STORAGE_MAC_INFO, input.timestamp, input.computerId.toLowerCase(), input.generation, input.leaseEpoch, digest].join('|');
}

export async function handleHostStorageSample(request: Request, deps: HostStorageDeps): Promise<Response> {
    if (!isAwsComputersEnabled(deps.env)) return answer(404, { error: 'not_found' });
    const secret = deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    if (!secret) return answer(503, { error: 'storage_unavailable', retryable: true });

    const computerId = request.headers.get('x-ezil-computer-id')?.toLowerCase() ?? '';
    const generation = request.headers.get('x-ezil-generation') ?? '';
    const leaseEpoch = request.headers.get('x-ezil-lease-epoch') ?? '';
    const timestamp = request.headers.get('x-ezil-timestamp') ?? '';
    const signature = request.headers.get('x-ezil-signature') ?? '';
    if (!UUID.test(computerId) || !COUNTER.test(generation) || !COUNTER.test(leaseEpoch) || Number(generation) > 2147483647
        || Number(leaseEpoch) > 2147483647 || !/^\d{1,12}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(signature)) return unauthenticated();
    const now = deps.now();
    if (!Number.isFinite(now.getTime())) return answer(503, { error: 'storage_unavailable', retryable: true });
    if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > STORAGE_SIGNATURE_SKEW_SECONDS) return answer(401, { error: 'storage_signature_stale' });

    let raw: string | null;
    try {
        raw = await readBillingBody(request);
    } catch {
        return answer(400, { error: 'storage_request_invalid' });
    }
    if (raw === null || Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return answer(413, { error: 'storage_request_too_large' });

    let placement: Placement | null;
    try {
        placement = await deps.placement(computerId);
    } catch {
        // A database outage or an image reservation: nothing decided, the host retries (bounded).
        return answer(503, { error: 'storage_unavailable', retryable: true });
    }
    // The epoch the host names must be this placement's CURRENT aws-ec2 epoch, still holding the
    // consumed-nonce proof the key is derived from (cleared at DRAINING/RETIRING and every new lease).
    // The MAC below binds the same epoch again (key and message use the placement's values); this
    // early comparison only answers a superseded epoch without deriving a key.
    if (!placement || placement.provider !== 'aws-ec2' || placement.computerId.toLowerCase() !== computerId
        || placement.generation !== Number(generation) || placement.leaseEpoch !== Number(leaseEpoch)
        || !RUNNING_CLASS_STATES.includes(placement.state) || !placement.instanceId
        || !placement.enrollConsumedHash || !HEX64.test(placement.enrollConsumedHash)) return unauthenticated();
    let key: Buffer;
    try {
        key = deriveControlKey(secret, { computerId, generation: placement.generation, leaseEpoch: placement.leaseEpoch, nonceHash: placement.enrollConsumedHash });
    } catch {
        return answer(503, { error: 'storage_unavailable', retryable: true });
    }
    const expected = createHmac('sha256', key).update(storageMacMessage({ timestamp, computerId,
        generation: placement.generation, leaseEpoch: placement.leaseEpoch, body: raw })).digest();
    const presented = Buffer.from(signature.slice(3), 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return unauthenticated();

    // Authenticated. Only now is the body parsed: strict, no ids, a bigint-sized count.
    let sample: z.infer<typeof bodySchema>;
    try {
        const parsed = bodySchema.safeParse(parseRebaseJson(raw, MAX_BODY_BYTES));
        if (!parsed.success) return answer(400, { error: 'storage_sample_invalid' });
        sample = parsed.data;
    } catch {
        return answer(400, { error: 'storage_sample_invalid' });
    }
    const bytes = BigInt(sample.bytes);
    const measuredAt = new Date(sample.measuredAt);
    if (bytes > INT8_MAX || !Number.isFinite(measuredAt.getTime())) return answer(400, { error: 'storage_sample_invalid' });
    if (measuredAt.getTime() > now.getTime() + STORAGE_SAMPLE_MAX_FUTURE_MS) return answer(422, { error: 'storage_sample_future' });
    if (measuredAt.getTime() < now.getTime() - STORAGE_SAMPLE_MAX_AGE_MS) return answer(422, { error: 'storage_sample_stale' });

    let outcome: 'recorded' | 'duplicate';
    try {
        outcome = await deps.record(placement.ownerUserId, { computerId, bytes, measuredAt, source: STORAGE_SAMPLE_SOURCE });
    } catch {
        return answer(503, { error: 'storage_unavailable', retryable: true });
    }
    return answer(200, { recorded: outcome === 'recorded' });
}
