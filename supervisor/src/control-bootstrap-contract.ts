import { z } from 'zod';
import { canonicalJson } from './control-protocol.js';
import { DeliverySchema, ProvisioningSchema } from './configuration-delivery-contract.js';

const uuid = DeliverySchema.shape.configurationId;
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
/** Written by the trusted controller only after current configuration, writer,
 * completed mount and provider checks. Syntax and a protected file alone do
 * not confer control-plane authorization. No key bytes enter this record. */
export const ControlBootstrapAuthorizationSchema = z.object({
    schemaVersion: z.literal(1), authorizationId: uuid, mountAuthorizationId: uuid,
    configuration: DeliverySchema.refine(value => value.operation === 'prepare'),
    controlDomain: z.string().max(190).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
    secretVersionId: z.string().regex(/^[A-Za-z0-9-]{32,64}$/),
    issuedAt: epoch, expiresAt: epoch,
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= 300);
export type ControlBootstrapAuthorization = z.infer<typeof ControlBootstrapAuthorizationSchema>;
export const ControlBootstrapRequestSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid }).strict();

export function validateControlBootstrap(input: unknown, provisioned: unknown, authorized: unknown, now = Date.now()) {
    const request = ControlBootstrapRequestSchema.safeParse(input), host = ProvisioningSchema.safeParse(provisioned),
        authority = ControlBootstrapAuthorizationSchema.safeParse(authorized);
    if (!request.success || !host.success || !authority.success || !Number.isSafeInteger(now)
        || authority.data.authorizationId !== request.data.authorizationId || authority.data.issuedAt > now / 1000
        || authority.data.expiresAt <= now / 1000
        || canonicalJson(authority.data.configuration.scope) !== canonicalJson(host.data.scope)) {
        throw new Error('control_bootstrap_invalid');
    }
    return { host: host.data, authority: authority.data };
}

export function controlSecretIdentity(host: z.infer<typeof ProvisioningSchema>, authority: ControlBootstrapAuthorization) {
    const scope = host.scope;
    return { name: `${host.namespace}/computers/${scope.computerId}/generations/${scope.computerGeneration}/control`,
        origin: `https://c-${scope.computerId}-g${scope.computerGeneration}.${authority.controlDomain}` };
}
