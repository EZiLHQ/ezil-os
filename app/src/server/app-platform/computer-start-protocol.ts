import { z } from 'zod';
import { canonicalConfiguration } from './computer-configuration';
import { ComputerControlKeyPolicySchema, ComputerControlScopeSchema, controlKeyArnMatches } from './computer-control-key';
import { LifecycleDeploymentSchema } from './lifecycle-deployment';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const generation = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Stable trusted work; never publisher/browser input or authority by itself.
 * Configuration bytes stay in their existing immutable artifact. This carries
 * enough DB-derived evidence to verify it without recreating or re-preparing it. */
export const ComputerStartWorkSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid,
    mountAuthorizationId: uuid, scope: ComputerControlScopeSchema,
    configuration: z.object({ configurationId: uuid, revision: generation, digest,
        bytes: z.number().int().min(2).max(262144) }).strict(),
    controlKey: z.object({ versionId: uuid, secretArn: z.string().max(1024), policy: ComputerControlKeyPolicySchema }).strict(),
    issuedAt: epoch, expiresAt: epoch, deployment: LifecycleDeploymentSchema,
}).strict().refine(w => w.expiresAt - w.issuedAt === 300
    && ['accountId', 'region', 'namespace'].every(k => w.deployment[k as 'accountId' | 'region' | 'namespace']
        === w.controlKey.policy[k as 'accountId' | 'region' | 'namespace'])
    && controlKeyArnMatches(w.controlKey.policy, { scope: w.scope, secretArn: null }, w.controlKey.secretArn), 'start_work_invalid');
export type ComputerStartWork = z.infer<typeof ComputerStartWorkSchema>;
export const ComputerStartReceiptSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid,
    scope: ComputerControlScopeSchema, state: z.literal('started'),
    descriptor: z.object({ computerId: uuid, computerGeneration: generation,
        configurationRevision: generation, configurationDigest: digest }).strict(),
}).strict();
export type ComputerStartReceipt = z.infer<typeof ComputerStartReceiptSchema>;
export function startReceiptMatches(w: ComputerStartWork, input: unknown): input is ComputerStartReceipt {
    const r = ComputerStartReceiptSchema.safeParse(input);
    return r.success && r.data.authorizationId === w.authorizationId
        && canonicalConfiguration(r.data.scope) === canonicalConfiguration(w.scope)
        && r.data.descriptor.computerId === w.scope.computerId && r.data.descriptor.computerGeneration === w.scope.computerGeneration
        && r.data.descriptor.configurationRevision === w.configuration.revision && r.data.descriptor.configurationDigest === w.configuration.digest;
}
