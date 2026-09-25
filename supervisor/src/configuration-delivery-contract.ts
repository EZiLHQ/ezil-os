import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './control-protocol.js';
import { parseHostConfig, installationPreparations } from './host-config.js';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const generation = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.object({ computerId: uuid, computerGeneration: generation, fenceToken: uuid,
    providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/), dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/) }).strict();
export const ProvisioningSchema = z.object({ schemaVersion: z.literal(1), scope,
    accountId: z.string().regex(/^[0-9]{12}$/), region: z.literal('us-east-1'),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/), kmsKeyArn: z.string(),
}).strict().superRefine((value, context) => {
    if (!new RegExp(`^arn:aws:kms:us-east-1:${value.accountId}:key/[a-f0-9-]{36}$`).test(value.kmsKeyArn)) {
        context.addIssue({ code: 'custom', message: 'invalid_kms_key' });
    }
});
export type Provisioning = z.infer<typeof ProvisioningSchema>;
export const DeliverySchema = z.object({ schemaVersion: z.literal(1), operation: z.enum(['prepare', 'reload']),
    configurationId: uuid, scope, revision: generation, digest,
    object: z.object({ bucket: z.string(), key: z.string().max(512), versionId: z.string().min(1).max(1024).refine(value => value !== 'null'),
        sha256: digest, bytes: z.number().int().min(2).max(262144) }).strict(),
}).strict();
export type Delivery = z.infer<typeof DeliverySchema>;
export const descriptor = (value: Delivery) => ({ computerId: value.scope.computerId, computerGeneration: value.scope.computerGeneration,
    configurationRevision: value.revision, configurationDigest: value.digest });

/** SSM/controller authority is external to this syntax check. The root-owned
 * provisioning record is independent of request data and cannot come from an app. */
export function validateDelivery(input: unknown, provisioned: unknown) {
    const parsed = DeliverySchema.safeParse(input), provisioning = ProvisioningSchema.safeParse(provisioned);
    if (!parsed.success || !provisioning.success) throw new Error('configuration_delivery_invalid');
    const value = parsed.data, host = provisioning.data;
    const key = `${host.namespace}/computers/${host.scope.computerId}/generations/${host.scope.computerGeneration}/configurations/${value.configurationId}.json`;
    if (canonicalJson(value.scope) !== canonicalJson(host.scope) || value.object.bucket !== host.bucket
        || value.object.key !== key || value.object.sha256 !== value.digest) throw new Error('configuration_delivery_invalid');
    return { value, host };
}

export function validateConfiguration(bytes: Buffer, value: Delivery, host: Provisioning, privateValidation = false) {
    if (bytes.length !== value.object.bytes || createHash('sha256').update(bytes).digest('hex') !== value.digest) {
        throw new Error('configuration_content_invalid');
    }
    try {
        const config = parseHostConfig(JSON.parse(bytes.toString()), privateValidation);
        if (canonicalJson(config) !== bytes.toString() || config.computerId !== host.scope.computerId
            || config.computerGeneration !== host.scope.computerGeneration || config.volumeId !== host.scope.dataVolumeId
            || config.configurationRevision !== value.revision) throw new Error();
        if (!privateValidation && (config.dataRoot !== '/srv/ezil-data' || config.stateDirectory !== '/var/lib/ezil-supervisor'
            || config.stagingRoot !== '/run/ezil-supervisor/mounts' || config.controlPort !== 8181 || config.memoryBudgetMiB !== 3072
            || installationPreparations(config).some(item => !item.image.startsWith(`${host.accountId}.dkr.ecr.us-east-1.amazonaws.com/`)))) throw new Error();
        return config;
    } catch { throw new Error('configuration_content_invalid'); }
}
