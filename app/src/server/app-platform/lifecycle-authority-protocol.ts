import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

export const LIFECYCLE_AUTHORITY_PATH = '/api/internal/computers/lifecycle-authority';
export const LifecycleAuthoritySecretSchema = z.string().regex(/^[a-f0-9]{64}$/, 'invalid_lifecycle_authority_secret');
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
export const LifecycleAuthorityRequestSchema = z.object({ schemaVersion: z.literal(1),
    computerId: uuid, jobId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type LifecycleAuthorityRequest = z.infer<typeof LifecycleAuthorityRequestSchema>;

/** Distinct realm/path/key from configuration delivery and host authentication.
 * Replays recheck current database authority; this is not an execution token. */
export function lifecycleAuthoritySignature(body: Uint8Array, secret: string, timestamp: string): string {
    if (!LifecycleAuthoritySecretSchema.safeParse(secret).success || !/^[0-9]{10}$/.test(timestamp)) {
        throw new Error('lifecycle_authority_signing_invalid');
    }
    return createHmac('sha256', Buffer.from(secret, 'hex')).update([
        'ezil-lifecycle-authority-v1', 'POST', LIFECYCLE_AUTHORITY_PATH, timestamp,
        createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest('hex');
}
