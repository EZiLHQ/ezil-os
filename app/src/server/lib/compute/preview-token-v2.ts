/**
 * App-side minter for the Worker's v2 signed envelope (docs/AWS-COMPUTERS.md
 * C-5). The verifier is `worker/src/hmac.ts` (`verifyPreviewTokenV2`); both
 * sides are held to `worker/src/preview-token-v2.vectors.json`.
 *
 * Signs `v2|ts|METHOD|path|sandboxId|computerId|userId|provider|store|generation|leaseEpoch|sha256hex(body)`
 * over the EXACT body string handed to `fetch`, and travels in the
 * `x-ezil-auth` header (never the body, which it digests).
 *
 * Off by default: only `EZIL_PREVIEW_TOKEN_V2=1` turns it on, and the Worker
 * must already verify v2 (P4a deployed) before anyone sets it.
 */

import { createHash, createHmac } from 'node:crypto';

export const PREVIEW_TOKEN_V2_HEADER = 'x-ezil-auth';

export interface PreviewTokenV2Claims {
    ts: number;
    sandboxId: string;
    computerId: string;
    userId: string;
    provider: 'cloudflare' | 'aws-ec2';
    /** '' = no store claim: the Worker keeps the computer's own (sticky) store. */
    store: 'r2' | 's3' | '';
    generation: number;
    leaseEpoch: number;
}

const ID = /^[A-Za-z0-9._:@-]{1,256}$/;

/** True only for the exact opt-in value. */
export function previewTokenV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
    return env.EZIL_PREVIEW_TOKEN_V2?.trim() === '1';
}

export function mintPreviewTokenV2(
    secret: string,
    claims: PreviewTokenV2Claims,
    req: { method: string; path: string; body: string },
): string {
    if (!secret || !secret.trim()) throw new Error('hmac_secret_not_configured');
    const c = claims;
    if (!Number.isSafeInteger(c.ts) || c.ts <= 0
        || ![c.sandboxId, c.computerId, c.userId].every((v) => ID.test(v))
        || !['cloudflare', 'aws-ec2'].includes(c.provider)
        || !['', 'r2', 's3'].includes(c.store)
        || !Number.isSafeInteger(c.generation) || c.generation < 0
        || !Number.isSafeInteger(c.leaseEpoch) || c.leaseEpoch < 0) {
        throw new Error('invalid v2 claims');
    }
    const method = req.method.toUpperCase();
    if (!/^\/[\x21-\x7e]{0,2047}$/.test(req.path) || req.path.includes('|')) throw new Error('invalid v2 path');
    const bodySha = createHash('sha256').update(req.body, 'utf8').digest('hex');
    const payload = ['v2', c.ts, method, req.path, c.sandboxId, c.computerId, c.userId, c.provider, c.store,
        c.generation, c.leaseEpoch, bodySha].join('|');
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    // Fixed key order: both minters must emit byte-identical tokens.
    const claimsJson = JSON.stringify({
        ts: c.ts, sandboxId: c.sandboxId, computerId: c.computerId, userId: c.userId,
        provider: c.provider, store: c.store, generation: c.generation, leaseEpoch: c.leaseEpoch,
    });
    return `v2.${Buffer.from(claimsJson, 'utf8').toString('base64url')}.${sig}`;
}

/**
 * How a Worker call authenticates. `v1` is today's envelope; `v2` carries the
 * claims (minus `ts`, stamped at send time) for the computer being addressed.
 */
export type WorkerAuth =
    | { kind: 'v1' }
    | { kind: 'v2'; claims: Omit<PreviewTokenV2Claims, 'ts'> };
