import { createHmac } from 'node:crypto';

const CONTROL_KEY_INFO = 'ezil-aws-control-key-v1';

/**
 * The epoch's GW-5 control key, DERIVED rather than random, so a host that retries an
 * enrollment whose 200 was lost gets the SAME key back:
 * HMAC-SHA256(secret, "ezil-aws-control-key-v1|computerId|generation|leaseEpoch|nonceHash").
 *
 * Nothing extra is stored for a replay. The only copies of the key stay where they already
 * were: the Worker's tunnel record (GW-1) and the host. A replay re-derives the key from the
 * nonce the host presents, and the Worker answers only when it equals the stored key exactly
 * (worker/src/aws-tunnels.ts `isExactReplay`), so a wrong nonce gets nothing. The secret is the
 * app↔Worker HMAC secret, whose holder can already sign Worker calls: no new exposure.
 */
export function deriveControlKey(secret: string, input: { computerId: string; generation: number; leaseEpoch: number; nonceHash: string }): Buffer {
    if (!secret.trim()) throw new Error('control_key_secret_not_configured');
    const info = [CONTROL_KEY_INFO, input.computerId.toLowerCase(), input.generation, input.leaseEpoch, input.nonceHash].join('|');
    return createHmac('sha256', secret).update(info).digest();
}
