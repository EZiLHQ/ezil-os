import { z } from 'zod';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const count = z.number().int().min(1).max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Scope = z.object({ computerId: uuid, computerGeneration: count, fenceToken: uuid,
    providerInstanceId: z.string().regex(/^i-[a-f0-9]{17}$/), dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/) }).strict();
/** Wire contract shared with the app transport and fixed host receiver. This
 * validates data, not ownership. Current authority is checked separately. */
export const DeliverySchema = z.object({ schemaVersion: z.literal(1), operation: z.enum(['prepare', 'reload']),
    configurationId: uuid, scope: Scope, revision: count, digest,
    object: z.object({ bucket: z.string(), key: z.string().max(512),
        versionId: z.string().min(1).max(1024).refine(v => v !== 'null'), sha256: digest,
        bytes: z.number().int().min(2).max(262144) }).strict(),
}).strict();
export type Delivery = z.infer<typeof DeliverySchema>;
export const SettingsSchema = z.object({ accountId: z.string().regex(/^[0-9]{12}$/), region: z.literal('us-east-1'),
    stage: z.enum(['pilot', 'production']), namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
    bucket: z.string().min(3).max(63).regex(/^[a-z][a-z0-9-]*[a-z0-9]$/),
    dataKeyArn: z.string(), machineArn: z.string(), workflowVersion: z.string().regex(/^[1-9][0-9]*$/),
    authorityOrigin: z.string(), authoritySecretArn: z.string(),
    documentName: z.string().regex(/^ezil-configuration-[a-z0-9-]{1,70}$/),
    documentVersion: z.string().regex(/^[1-9][0-9]*$/), documentHash: digest,
}).strict().superRefine((v, ctx) => {
    const prefix = `arn:aws:`, regionAccount = `${v.region}:${v.accountId}:`;
    const valid = new RegExp(`^${prefix}kms:${regionAccount}key/[a-f0-9-]{36}$`).test(v.dataKeyArn)
        && new RegExp(`^${prefix}states:${regionAccount}stateMachine:[A-Za-z0-9_-]{1,80}$`).test(v.machineArn)
        && new RegExp(`^${prefix}secretsmanager:${regionAccount}secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`).test(v.authoritySecretArn)
        && /^https:\/\/(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/.test(v.authorityOrigin);
    if (!valid) ctx.addIssue({ code: 'custom', message: 'invalid_delivery_settings' });
});
export type Settings = z.infer<typeof SettingsSchema>;
export const canonical = (v: unknown): string => JSON.stringify(v, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const resultFor = (d: Delivery) => ({ schemaVersion: 1, configurationId: d.configurationId, scope: d.scope,
    operation: d.operation, descriptor: { computerId: d.scope.computerId, computerGeneration: d.scope.computerGeneration,
        configurationRevision: d.revision, configurationDigest: d.digest } });
export const authorityFor = ({ object: _object, ...request }: Delivery) => request;
export function parseDelivery(input: unknown, settings: Settings): Delivery {
    const parsed = DeliverySchema.safeParse(input);
    if (!parsed.success) throw new Error('invalid_delivery');
    const d = parsed.data;
    if (d.object.bucket !== settings.bucket || d.object.sha256 !== d.digest
        || d.object.key !== `${settings.namespace}/computers/${d.scope.computerId}/generations/${d.scope.computerGeneration}/configurations/${d.configurationId}.json`) {
        throw new Error('invalid_delivery');
    }
    return d;
}
export type HostAction = 'start' | 'observe' | 'cancel';
export function hostOperation(delivery: Delivery, action: HostAction, deadline: number) {
    const bytes = Buffer.from(canonical({ schemaVersion: 1, action, delivery, ...(action === 'start' ? { deadline } : {}) }));
    if (bytes.length > 8192) throw new Error('invalid_delivery');
    return bytes.toString('base64');
}
const HostObservation = z.object({ schemaVersion: z.literal(1), configurationId: uuid, scope: Scope,
    operation: z.enum(['prepare', 'reload']), status: z.enum(['absent', 'unknown', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled']),
    result: z.unknown().optional(),
}).strict();
export function hostObservation(output: string, delivery: Delivery) {
    if (Buffer.byteLength(output) > 4096) throw new Error('invalid_host_output');
    try {
        const v = HostObservation.parse(JSON.parse(output));
        if (v.configurationId !== delivery.configurationId || !equal(v.scope, delivery.scope) || v.operation !== delivery.operation
            || (v.status === 'succeeded' ? !equal(v.result, resultFor(delivery)) : 'result' in v)) throw new Error();
        return v.status;
    } catch { throw new Error('invalid_host_output'); }
}
