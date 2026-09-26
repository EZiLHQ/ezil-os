import { z } from 'zod';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
export const ComputerControlScopeSchema = z.object({ computerId: uuid,
    computerGeneration: z.number().int().min(1).max(2147483647), fenceToken: uuid,
    providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/), dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/),
}).strict();
/** Operator settings, never manifest/browser input. DNS/domain ownership and
 * KMS/IAM approval require deployment validation beyond this syntax check. */
export const ComputerControlKeyPolicySchema = z.object({ accountId: z.string().regex(/^[0-9]{12}$/),
    region: z.literal('us-east-1'), namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    controlDomain: z.string().max(190).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
    kmsKeyArn: z.string(),
}).strict().refine(p => new RegExp(`^arn:aws:kms:${p.region}:${p.accountId}:key/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(p.kmsKeyArn));
export type ComputerControlKeyPolicy = z.infer<typeof ComputerControlKeyPolicySchema>;
export const ComputerControlKeyWorkSchema = z.object({ versionId: uuid, scope: ComputerControlScopeSchema,
    attemptedAt: z.string().datetime(), secretArn: z.string().nullable(),
}).strict();
export type ComputerControlKeyWork = z.infer<typeof ComputerControlKeyWorkSchema>;
export const ComputerControlKeyObservationSchema = z.discriminatedUnion('state', [
    z.object({ state: z.literal('missing') }).strict(),
    z.object({ state: z.literal('confirmed'), versionId: uuid, secretArn: z.string() }).strict(),
]);
export type ComputerControlKeyObservation = z.infer<typeof ComputerControlKeyObservationSchema>;
export interface ComputerControlKeys {
    readonly policy: ComputerControlKeyPolicy;
    /** create is allowed ONLY to the transaction that first persisted the
     * attempt marker. All crash/timeout/concurrent retries use observe, even
     * when the key is missing. Neither operation starts the supervisor. */
    prepare(work: ComputerControlKeyWork, mode: 'create' | 'observe', signal: AbortSignal): Promise<ComputerControlKeyObservation>;
}
export function computerControlKeyIdentity(policy: ComputerControlKeyPolicy, work: Pick<ComputerControlKeyWork, 'scope'>) {
    const s = work.scope;
    const name = `${policy.namespace}/computers/${s.computerId}/generations/${s.computerGeneration}/control`;
    return { name, arnPrefix: `arn:aws:secretsmanager:${policy.region}:${policy.accountId}:secret:${name}-`,
        origin: `https://c-${s.computerId}-g${s.computerGeneration}.${policy.controlDomain}` };
}
export function controlKeyArnMatches(policy: ComputerControlKeyPolicy, work: Pick<ComputerControlKeyWork, 'scope' | 'secretArn'>, arn: string) {
    const { arnPrefix } = computerControlKeyIdentity(policy, work);
    return arn.startsWith(arnPrefix) && /^[A-Za-z0-9]{6}$/.test(arn.slice(arnPrefix.length))
        && (work.secretArn === null || work.secretArn === arn);
}
