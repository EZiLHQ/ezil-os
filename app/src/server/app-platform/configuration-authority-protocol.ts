import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

export const CONFIGURATION_AUTHORITY_PATH = '/api/internal/apps/configuration-authority';
export const ConfigurationAuthoritySecretSchema = z.string().regex(/^[a-f0-9]{64}$/, 'invalid_configuration_authority_secret');
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const generation = z.number().int().min(1).max(2_147_483_647);
export const ConfigurationAuthorityRequestSchema = z.object({
    schemaVersion: z.literal(1), configurationId: uuid, operation: z.enum(['prepare', 'reload']),
    revision: generation, digest: z.string().regex(/^[a-f0-9]{64}$/),
    scope: z.object({ computerId: uuid, computerGeneration: generation,
        providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/), dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/), fenceToken: uuid }).strict(),
}).strict();
export type ConfigurationAuthorityRequest = z.infer<typeof ConfigurationAuthorityRequestSchema>;

/** Dedicated controller authentication, not a host key or an OS/app credential.
 * It signs the exact raw body, fixed method/path, protocol realm and timestamp. */
export function configurationAuthoritySignature(body: Uint8Array, secret: string, timestamp: string): string {
    if (!ConfigurationAuthoritySecretSchema.safeParse(secret).success || !/^[0-9]{10}$/.test(timestamp)) {
        throw new Error('configuration_authority_signing_invalid');
    }
    const digest = createHash('sha256').update(body).digest('hex');
    return createHmac('sha256', Buffer.from(secret, 'hex'))
        .update(`ezil-configuration-authority-v1\nPOST\n${CONFIGURATION_AUTHORITY_PATH}\n${timestamp}\n${digest}`).digest('hex');
}
