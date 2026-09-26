import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Scope } from '../delivery/contract.js';
import { LifecycleDeploymentSchema } from '../lifecycle/deployment.js';
import { canonical, equal, SettingsSchema as LifecycleSettings } from '../lifecycle/contract.js';
export { canonical, equal };

const uuid = Scope.shape.computerId, digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
const mode = z.enum(['initialize', 'mount']);
const authorization = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, scope: Scope,
    filesystemUuid: uuid, mode, digest, issuedAt: epoch, expiresAt: epoch }).strict()
    .refine(a => a.expiresAt - a.issuedAt === 900);
const plan = z.object({ computerId: uuid, filesystemUuid: uuid, mode, schemaVersion: z.literal(1),
    volumeId: Scope.shape.dataVolumeId }).strict();
/** Exact app transport input. Syntax never grants ownership or formatting authority. */
export const WorkSchema = z.object({ authorization, plan, deployment: LifecycleDeploymentSchema }).strict().refine(w =>
    w.plan.computerId === w.authorization.scope.computerId && w.plan.volumeId === w.authorization.scope.dataVolumeId
    && w.plan.filesystemUuid === w.authorization.filesystemUuid && w.plan.mode === w.authorization.mode
    && createHash('sha256').update(canonical(w.plan)).digest('hex') === w.authorization.digest);
export const InputSchema = z.object({ schemaVersion: z.literal(1), work: WorkSchema, object: z.object({
    bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/), key: z.string().max(512),
    versionId: z.string().min(1).max(1024).refine(v => v !== 'null'), sha256: digest,
    bytes: z.number().int().min(2).max(4096) }).strict() }).strict();
export type MountInput = z.infer<typeof InputSchema>;
export const SettingsSchema = LifecycleSettings.innerType().extend({ bucket: InputSchema.shape.object.shape.bucket,
    machineArn: z.string(), workflowVersion: z.string().regex(/^[1-9][0-9]*$/),
    documentName: z.string().regex(/^ezil-mount-[a-z0-9-]{1,70}$/),
    documentVersion: z.string().regex(/^[1-9][0-9]*$/), documentHash: digest,
}).strict().superRefine((s,ctx) => {
    const { bucket: _b, machineArn, workflowVersion: _v, documentName: _n, documentVersion: _dv, documentHash: _h, ...base } = s;
    if (!LifecycleSettings.safeParse(base).success
        || !new RegExp(`^arn:aws:states:us-east-1:${s.deployment.accountId}:stateMachine:[A-Za-z0-9_-]{1,60}$`).test(machineArn)) {
        ctx.addIssue({ code:'custom', message:'invalid_mount_settings' });
    }
});
export type Settings = z.infer<typeof SettingsSchema>;
export function parseInput(value: unknown, s: Settings): MountInput {
    try {
        const input = InputSchema.parse(value), a = input.work.authorization;
        const profile = `arn:aws:iam::${s.deployment.accountId}:instance-profile/${s.writerRolePathPrefix}/${a.scope.computerId}/g${a.scope.computerGeneration}`;
        if (!equal(input.work.deployment, { ...s.deployment, instanceProfileArn: profile }) || input.object.bucket !== s.bucket
            || input.object.key !== `${s.deployment.namespace}/computers/${a.scope.computerId}/generations/${a.scope.computerGeneration}/data-mounts/${a.authorizationId}.json`
            || input.object.bytes !== Buffer.byteLength(canonical(input.work.plan)) || input.object.sha256 !== a.digest) throw new Error();
        return input;
    } catch { throw new Error('mount_input_invalid'); }
}
export function hostRecords(i: MountInput, s: Settings) {
    const a = i.work.authorization, d = i.work.deployment;
    return { provisioning: { schemaVersion: 1, scope: a.scope, accountId: d.accountId, region: d.region,
        namespace: d.namespace, bucket: s.bucket, kmsKeyArn: d.dataKeyArn }, authorization: a,
        delivery: { schemaVersion: 1, authorizationId: a.authorizationId, scope: a.scope, digest: a.digest, object: i.object } };
}
export type HostAction = 'start' | 'observe' | 'cancel';
export function hostOperation(i: MountInput, s: Settings, action: HostAction) {
    const bytes = Buffer.from(canonical({ schemaVersion: 1, action, records: hostRecords(i,s) }));
    if (bytes.length > 16384) throw new Error('mount_input_invalid');
    return bytes.toString('base64');
}
export const receiptFor = (i: MountInput) => ({ schemaVersion: 1, authorizationId: i.work.authorization.authorizationId,
    scope: i.work.authorization.scope, digest: i.work.authorization.digest, state: 'mounted',
    computerId: i.work.plan.computerId, volumeId: i.work.plan.volumeId, filesystemUuid: i.work.plan.filesystemUuid });
const Observation = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, scope: Scope,
    status: z.enum(['absent','unknown','running','succeeded','failed','cancelling','cancelled']), result: z.unknown().optional() }).strict();
export function hostObservation(output: string, i: MountInput) {
    try {
        if (Buffer.byteLength(output) > 4096) throw new Error();
        const v = Observation.parse(JSON.parse(output));
        if (v.authorizationId !== i.work.authorization.authorizationId || !equal(v.scope,i.work.authorization.scope)
            || (v.status === 'succeeded' ? !equal(v.result,receiptFor(i)) : 'result' in v)) throw new Error();
        return v.status;
    } catch { throw new Error('mount_output_invalid'); }
}
