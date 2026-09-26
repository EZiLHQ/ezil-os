import { z } from 'zod';
import { Scope, DeliverySchema } from '../delivery/contract.js';
import { LifecycleDeploymentSchema } from '../lifecycle/deployment.js';
import { canonical, equal, SettingsSchema as LifecycleSettings } from '../lifecycle/contract.js';
export { canonical, equal };

const uuid = Scope.shape.computerId, digest = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000));
const bucket = z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/);
const ControlKeyPolicy = z.object({ accountId: z.string().regex(/^[0-9]{12}$/), region: z.literal('us-east-1'),
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    controlDomain: z.string().max(190).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
    kmsKeyArn: z.string(),
}).strict().refine(p => new RegExp(`^arn:aws:kms:${p.region}:${p.accountId}:key/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`).test(p.kmsKeyArn));
/** Exact app transport input; syntax is never ownership or startup authority. */
export const WorkSchema = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, mountAuthorizationId: uuid,
    scope: Scope, configuration: z.object({ configurationId: uuid, revision: Scope.shape.computerGeneration, digest,
        bytes: z.number().int().min(2).max(262144) }).strict(),
    controlKey: z.object({ versionId: uuid, secretArn: z.string().max(1024), policy: ControlKeyPolicy }).strict(),
    issuedAt: epoch, expiresAt: epoch, deployment: LifecycleDeploymentSchema,
}).strict().refine(w => {
    const p = w.controlKey.policy, s = w.scope;
    const prefix = `arn:aws:secretsmanager:${p.region}:${p.accountId}:secret:${p.namespace}/computers/${s.computerId}/generations/${s.computerGeneration}/control-`;
    return w.expiresAt - w.issuedAt === 300 && p.accountId === w.deployment.accountId && p.region === w.deployment.region
        && p.namespace === w.deployment.namespace && w.controlKey.secretArn.startsWith(prefix)
        && /^[A-Za-z0-9]{6}$/.test(w.controlKey.secretArn.slice(prefix.length));
});
export const InputSchema = z.object({ schemaVersion: z.literal(1), work: WorkSchema, configuration: DeliverySchema }).strict();
export type StartInput = z.infer<typeof InputSchema>;
export const SettingsSchema = LifecycleSettings.innerType().extend({ bucket, controlKeyPolicy: ControlKeyPolicy,
    machineArn: z.string(), workflowVersion: z.string().regex(/^[1-9][0-9]*$/),
    documentName: z.string().regex(/^ezil-start-[a-z0-9-]{1,70}$/),
    documentVersion: z.string().regex(/^[1-9][0-9]*$/), documentHash: digest,
}).strict().superRefine((s, ctx) => {
    const { bucket: _b, controlKeyPolicy: p, machineArn, workflowVersion: _v, documentName: _n,
        documentVersion: _dv, documentHash: _h, ...base } = s;
    if (!LifecycleSettings.safeParse(base).success || p.accountId !== s.deployment.accountId
        || p.region !== s.deployment.region || p.namespace !== s.deployment.namespace
        || !new RegExp(`^arn:aws:states:us-east-1:${s.deployment.accountId}:stateMachine:[A-Za-z0-9_-]{1,60}$`).test(machineArn)) {
        ctx.addIssue({ code: 'custom', message: 'invalid_start_settings' });
    }
});
export type Settings = z.infer<typeof SettingsSchema>;
export function parseInput(value: unknown, s: Settings): StartInput {
    try {
        const i = InputSchema.parse(value), w = i.work, c = i.configuration;
        const profile = `arn:aws:iam::${s.deployment.accountId}:instance-profile/${s.writerRolePathPrefix}/${w.scope.computerId}/g${w.scope.computerGeneration}`;
        if (Buffer.byteLength(canonical(i)) > 16384 || !equal(w.deployment, { ...s.deployment, instanceProfileArn: profile })
            || !equal(w.controlKey.policy, s.controlKeyPolicy) || !equal(c.scope, w.scope)
            || c.operation !== 'prepare' || c.configurationId !== w.configuration.configurationId
            || c.revision !== w.configuration.revision || c.digest !== w.configuration.digest
            || c.object.sha256 !== w.configuration.digest || c.object.bytes !== w.configuration.bytes
            || c.object.bucket !== s.bucket
            || c.object.key !== `${s.deployment.namespace}/computers/${w.scope.computerId}/generations/${w.scope.computerGeneration}/configurations/${c.configurationId}.json`) throw new Error();
        return i;
    } catch { throw new Error('start_input_invalid'); }
}
export function hostRecords(i: StartInput, s: Settings) {
    const w = i.work, d = w.deployment;
    return { provisioning: { schemaVersion: 1, scope: w.scope, accountId: d.accountId, region: d.region,
        namespace: d.namespace, bucket: s.bucket, kmsKeyArn: d.dataKeyArn },
    authorization: { schemaVersion: 1, authorizationId: w.authorizationId, mountAuthorizationId: w.mountAuthorizationId,
        configuration: i.configuration, controlDomain: w.controlKey.policy.controlDomain, secretVersionId: w.controlKey.versionId,
        issuedAt: w.issuedAt, expiresAt: w.expiresAt } };
}
export type HostAction = 'start' | 'observe' | 'cancel';
export function hostOperation(i: StartInput, s: Settings, action: HostAction) {
    const bytes = Buffer.from(canonical({ schemaVersion: 1, action, records: hostRecords(i, s) }));
    if (bytes.length > 16384) throw new Error('start_input_invalid');
    return bytes.toString('base64');
}
export const receiptFor = (i: StartInput) => ({ schemaVersion: 1, authorizationId: i.work.authorizationId,
    scope: i.work.scope, state: 'started', descriptor: { computerId: i.work.scope.computerId,
        computerGeneration: i.work.scope.computerGeneration, configurationRevision: i.work.configuration.revision,
        configurationDigest: i.work.configuration.digest } });
const Observation = z.object({ schemaVersion: z.literal(1), authorizationId: uuid, scope: Scope,
    status: z.enum(['absent', 'unknown', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled']), result: z.unknown().optional() }).strict();
export function hostObservation(output: string, i: StartInput) {
    try {
        if (Buffer.byteLength(output) > 4096) throw new Error();
        const v = Observation.parse(JSON.parse(output));
        if (v.authorizationId !== i.work.authorizationId || !equal(v.scope, i.work.scope)
            || (v.status === 'succeeded' ? !equal(v.result, receiptFor(i)) : 'result' in v)) throw new Error();
        return v.status;
    } catch { throw new Error('start_output_invalid'); }
}
