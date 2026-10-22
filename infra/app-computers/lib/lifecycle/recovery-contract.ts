import { z } from 'zod';
import { SettingsSchema } from './contract.js';

export const RecoverySettingsSchema = z.object({
    lifecycle: SettingsSchema,
    recoveryVersionArn: z.string(),
}).strict().superRefine((s, ctx) => {
    const d = s.lifecycle.deployment;
    if (d.recoveryStateMachineVersionArn && s.recoveryVersionArn !== d.recoveryStateMachineVersionArn)
        ctx.addIssue({ code: 'custom', message: 'recovery_version_mismatch' });
    if (!new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`).test(s.recoveryVersionArn)
        || machineArn(s.recoveryVersionArn) === machineArn(d.stateMachineVersionArn)
        || !machineArn(s.recoveryVersionArn).split(':').at(-1)!.startsWith(`ezil-${d.namespace}-`)) {
        ctx.addIssue({ code: 'custom', message: 'invalid_recovery_settings' });
    }
});
export const machineArn = (version: string) => version.slice(0, version.lastIndexOf(':'));
export type RecoverySettings = z.infer<typeof RecoverySettingsSchema>;
export const RecoveryInputSchema = z.object({ sourceExecutionArn: z.string().max(300) }).strict();
export const recoveryPhases = ['initial', 'old-stopped', 'old-terminated', 'target-stopped', 'target-terminated'] as const;
export type RecoveryPhase = typeof recoveryPhases[number];
export interface RecoveryReceipt {
    schemaVersion: 1;
    sourceExecutionArn: string;
    jobId: string;
    digest: string;
    computerId: string;
    state: 'fenced';
    volumeId: string | null;
    instances: { instanceId: string; generation: number; fenceToken: string; state: 'terminated' }[];
}
