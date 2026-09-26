import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema } from './lifecycle-deployment';
import { canonicalConfiguration } from './computer-configuration';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.object({ computerId: uuid, computerGeneration: z.number().int().min(1).max(2147483647),
    fenceToken: uuid, providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
    dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/) }).strict();
const epoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const mode = z.enum(['initialize', 'mount']);
const authorization = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, scope,
    filesystemUuid: uuid, mode, digest, issuedAt: epoch, expiresAt: epoch }).strict()
    .refine(a => a.expiresAt - a.issuedAt === 900, 'invalid_mount_lifetime');
const plan = z.object({ computerId: uuid, filesystemUuid: uuid, mode, schemaVersion: z.literal(1),
    volumeId: scope.shape.dataVolumeId }).strict();
/** Trusted work, never a public API input or authority by itself. No caller
 * chooses S3 keys, command IDs, disk paths, or new initialization permissions. */
export const ComputerMountWorkSchema = z.object({ authorization, plan, deployment: LifecycleDeploymentSchema }).strict()
    .refine(w => w.plan.computerId === w.authorization.scope.computerId
        && w.plan.volumeId === w.authorization.scope.dataVolumeId && w.plan.filesystemUuid === w.authorization.filesystemUuid
        && w.plan.mode === w.authorization.mode
        && createHash('sha256').update(canonicalConfiguration(w.plan)).digest('hex') === w.authorization.digest,
    'invalid_mount_content');
export type ComputerMountWork = z.infer<typeof ComputerMountWorkSchema>;
export const ComputerMountReceiptSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, scope,
    digest, state: z.literal('mounted'), computerId: uuid, volumeId: scope.shape.dataVolumeId, filesystemUuid: uuid }).strict();
export type ComputerMountReceipt = z.infer<typeof ComputerMountReceiptSchema>;

export function mountReceiptMatches(work: ComputerMountWork, input: unknown): input is ComputerMountReceipt {
    const r = ComputerMountReceiptSchema.safeParse(input), a = work.authorization;
    return r.success && r.data.authorizationId === a.authorizationId && r.data.digest === a.digest
        && canonicalConfiguration(r.data.scope) === canonicalConfiguration(a.scope)
        && r.data.computerId === a.scope.computerId && r.data.volumeId === a.scope.dataVolumeId
        && r.data.filesystemUuid === a.filesystemUuid;
}
