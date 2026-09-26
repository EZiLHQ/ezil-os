import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './control-protocol.js';
import { DeliverySchema, ProvisioningSchema } from './configuration-delivery-contract.js';
import { DataMountPlanSchema } from './data-mount-plan.js';

const uuid = DataMountPlanSchema.shape.computerId;
const digest = DeliverySchema.shape.digest;
const epoch = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
/** Separate root-owned authorization, delivered by the trusted controller.
 * A reserved filesystem UUID, S3 object, or caller-supplied mode grants nothing.
 * The issuer must verify the current writer/attachment and permit initialize
 * only for its newly allocated disk. Retained/replacement disks use mount. */
export const DataMountAuthorizationSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid,
    scope: DeliverySchema.shape.scope, filesystemUuid: uuid, mode: DataMountPlanSchema.shape.mode,
    digest, issuedAt: epoch, expiresAt: epoch,
}).strict().refine(v => v.expiresAt > v.issuedAt && v.expiresAt - v.issuedAt <= 900, 'invalid_authority_lifetime');
export const DataMountDeliverySchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid,
    scope: DeliverySchema.shape.scope, digest, object: DeliverySchema.shape.object,
}).strict();
export type DataMountDelivery = z.infer<typeof DataMountDeliverySchema>;
export type DataMountAuthorization = z.infer<typeof DataMountAuthorizationSchema>;

export function validateDataMountDelivery(input: unknown, provisioned: unknown, authorized: unknown, now = Date.now()) {
    const request = DataMountDeliverySchema.safeParse(input), provisioning = ProvisioningSchema.safeParse(provisioned),
        approval = DataMountAuthorizationSchema.safeParse(authorized);
    if (!request.success || !provisioning.success || !approval.success || !Number.isSafeInteger(now)) throw new Error('data_mount_delivery_invalid');
    const value = request.data, host = provisioning.data, authority = approval.data;
    const key = `${host.namespace}/computers/${host.scope.computerId}/generations/${host.scope.computerGeneration}/data-mounts/${authority.authorizationId}.json`;
    if (canonicalJson(value.scope) !== canonicalJson(host.scope) || canonicalJson(authority.scope) !== canonicalJson(host.scope)
        || value.authorizationId !== authority.authorizationId || value.digest !== authority.digest
        || value.object.bucket !== host.bucket || value.object.key !== key || value.object.bytes > 4096
        || value.object.sha256 !== value.digest || authority.issuedAt > now / 1000 || authority.expiresAt <= now / 1000) {
        throw new Error('data_mount_delivery_invalid');
    }
    return { value, host, authority };
}

export function validateDeliveredMountPlan(bytes: Buffer, value: DataMountDelivery, authority: DataMountAuthorization) {
    try {
        if (bytes.length !== value.object.bytes || createHash('sha256').update(bytes).digest('hex') !== value.digest) throw new Error();
        const plan = DataMountPlanSchema.parse(JSON.parse(bytes.toString()));
        if (canonicalJson(plan) !== bytes.toString() || plan.computerId !== value.scope.computerId
            || plan.volumeId !== value.scope.dataVolumeId || plan.filesystemUuid !== authority.filesystemUuid
            || plan.mode !== authority.mode) throw new Error();
        return plan;
    } catch { throw new Error('data_mount_content_invalid'); }
}
