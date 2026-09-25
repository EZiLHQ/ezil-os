import { z } from 'zod';
import { LifecycleDeploymentSchema, type LifecycleDeployment } from './lifecycle-deployment';

/** Shared operator pins plus a deterministic per-writer profile. No publisher
 * or request may choose a profile, path, account or workflow version. Legacy
 * exact-profile approvals remain readable for historical work. */
const shared = LifecycleDeploymentSchema.innerType().omit({ instanceProfileArn: true });
export const LifecycleApprovalSchema = z.union([LifecycleDeploymentSchema, z.object({
    profileMode: z.literal('per-writer'), deployment: shared,
}).strict().refine(a => LifecycleDeploymentSchema.safeParse({ ...a.deployment,
    instanceProfileArn: `arn:aws:iam::${a.deployment.accountId}:instance-profile/validation` }).success)]);
export type LifecycleApproval = z.infer<typeof LifecycleApprovalSchema>;
export function lifecycleDeploymentApproved(approvals: readonly LifecycleApproval[], intent: {
    computerId: string; targetGeneration: number; deployment: LifecycleDeployment;
}): boolean {
    return approvals.some(value => {
        const parsed = LifecycleApprovalSchema.safeParse(value);
        if (!parsed.success) return false;
        const a = parsed.data;
        const expected = 'profileMode' in a ? { ...a.deployment,
            instanceProfileArn: `arn:aws:iam::${a.deployment.accountId}:instance-profile/ezil/${a.deployment.namespace}/computers/${intent.computerId}/g${intent.targetGeneration}` } : a;
        return Object.entries(expected).every(([key, value]) => intent.deployment[key as keyof LifecycleDeployment] === value);
    });
}
