import { z } from 'zod';

export const LifecycleDeploymentSchema = z.object({
    accountId: z.string().regex(/^\d{12}$/), region: z.literal('us-east-1'),
    availabilityZone: z.string().regex(/^us-east-1[a-z]$/),
    subnetId: z.string().regex(/^subnet-[a-f0-9]{17}$/), securityGroupId: z.string().regex(/^sg-[a-f0-9]{17}$/),
    launchTemplateId: z.string().regex(/^lt-[a-f0-9]{17}$/), launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/),
    amiId: z.string().regex(/^ami-[a-f0-9]{17}$/), namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    instanceProfileArn: z.string().max(600), dataKeyArn: z.string(), stateMachineVersionArn: z.string(),
}).strict().superRefine((d, ctx) => {
    const matches = {
        instanceProfileArn: new RegExp(`^arn:aws:iam::${d.accountId}:instance-profile/[A-Za-z0-9/+=,.@_-]+$`),
        dataKeyArn: new RegExp(`^arn:aws:kms:us-east-1:${d.accountId}:key/[a-f0-9-]{36}$`),
        stateMachineVersionArn: new RegExp(`^arn:aws:states:us-east-1:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`),
    };
    for (const [field, pattern] of Object.entries(matches)) if (!pattern.test(d[field as keyof typeof matches])) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'invalid_deployment_reference' });
    }
});
export type LifecycleDeployment = z.infer<typeof LifecycleDeploymentSchema>;
