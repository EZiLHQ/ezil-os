import { z } from 'zod';

/** R10: closed allowlist. m6i.large is the 2 vCPU / 8 GiB pilot baseline;
 * c6i.xlarge (4 vCPU / 8 GiB) is for benchmarks only. No burstable types.
 * A deployment may narrow this list but never extend it. */
export const INSTANCE_TYPES = ['m6i.large', 'c6i.xlarge'] as const;
export const InstanceTypeSchema = z.enum(INSTANCE_TYPES);
export type InstanceType = z.infer<typeof InstanceTypeSchema>;

/** R1: one commercial region per deployment, configured. */
export const REGION_PATTERN = /^[a-z]{2}-(north|south|east|west|central|northeast|southeast|northwest|southwest)-[1-9]$/;
/** R1: zones are addressed only by ZoneId (for example aps1-az1), never by
 * account-mapped zone names. */
export const ZONE_ID_PATTERN = /^[a-z]{2,4}\d-az\d+$/;
const DIRECTION: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w', central: 'c',
    northeast: 'ne', southeast: 'se', northwest: 'nw', southwest: 'sw' };
/** ap-south-1 -> aps1, eu-west-2 -> euw2, ap-northeast-1 -> apne1. */
export function zoneIdPrefix(region: string): string {
    const m = REGION_PATTERN.exec(region);
    if (!m) throw new Error('invalid_region');
    const [geo, direction, number] = region.split('-') as [string, string, string];
    return `${geo}${DIRECTION[direction]}${number}`;
}
export function zoneIdMatchesRegion(zoneId: string, region: string): boolean {
    return ZONE_ID_PATTERN.test(zoneId) && REGION_PATTERN.test(region) && zoneId.startsWith(`${zoneIdPrefix(region)}-az`);
}

/** R11: sizes come from configuration, never literals. Data volumes may grow
 * online, so an observed data volume is valid anywhere in [min, max]. */
export const StorageSchema = z.object({
    rootGiB: z.number().int().min(8).max(64),
    dataMinGiB: z.number().int().min(1).max(16384),
    dataMaxGiB: z.number().int().min(1).max(16384),
}).strict().refine(s => s.dataMinGiB <= s.dataMaxGiB, { message: 'invalid_storage_range' });
export type Storage = z.infer<typeof StorageSchema>;
/** Public defaults: root 20 GiB; data 20 GiB (free) or 50 GiB (premium); max 100 GiB. */
export const DEFAULT_STORAGE: Storage = { rootGiB: 20, dataMinGiB: 20, dataMaxGiB: 100 };
export const DEFAULT_DATA_TIERS_GIB = { free: 20, premium: 50 } as const;

/** Names reserved for identity and operator resources. A namespace equal to
 * one of them would make the workload IAM path (/ezil/<ns>/) collide with
 * /ezil/identity/ or /ezil/operators/ and let bounded principals edit the
 * boundary or the deploy and execution roles. */
export const RESERVED_NAMESPACES = ['identity', 'operators', 'operator', 'admin', 'root', 'ops', 'deploy', 'boundary', 'aws', 'service'] as const;
/** Lowercase letters and digits only: no '-', so `ezil-<ns>-*` can never match
 * another namespace's `ezil-<ns>-<more>-*` names. */
export const NamespaceSchema = z.string().regex(/^[a-z][a-z0-9]{0,20}$/)
    .refine(n => !(RESERVED_NAMESPACES as readonly string[]).includes(n), { message: 'reserved_namespace' });
export const machineName = (versionArn: string) => versionArn.slice(0, versionArn.lastIndexOf(':')).split(':').at(-1) ?? '';

export const LifecycleDeploymentSchema = z.object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    zoneId: z.string().regex(ZONE_ID_PATTERN),
    subnetId: z.string().regex(/^subnet-[a-f0-9]{17}$/), securityGroupId: z.string().regex(/^sg-[a-f0-9]{17}$/),
    launchTemplateId: z.string().regex(/^lt-[a-f0-9]{17}$/), launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/),
    amiId: z.string().regex(/^ami-[a-f0-9]{17}$/), namespace: NamespaceSchema,
    instanceTypes: z.array(InstanceTypeSchema).min(1).max(INSTANCE_TYPES.length),
    storage: StorageSchema,
    dataKeyArn: z.string(), stateMachineVersionArn: z.string(),
}).strict().superRefine((d, ctx) => {
    if (!zoneIdMatchesRegion(d.zoneId, d.region)) ctx.addIssue({ code: 'custom', path: ['zoneId'], message: 'zone_not_in_region' });
    // Exec-role IAM scopes state machines to ezil-<ns>-* names.
    if (!machineName(d.stateMachineVersionArn).startsWith(`ezil-${d.namespace}-`))
        ctx.addIssue({ code: 'custom', path: ['stateMachineVersionArn'], message: 'machine_name_not_in_namespace' });
    if (new Set(d.instanceTypes).size !== d.instanceTypes.length) ctx.addIssue({ code: 'custom', path: ['instanceTypes'], message: 'duplicate_instance_type' });
    const matches = {
        dataKeyArn: new RegExp(`^arn:aws:kms:${d.region}:${d.accountId}:key/[a-f0-9-]{36}$`),
        stateMachineVersionArn: new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`),
    };
    for (const [field, pattern] of Object.entries(matches)) if (!pattern.test(d[field as keyof typeof matches])) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'invalid_deployment_reference' });
    }
});
export type LifecycleDeployment = z.infer<typeof LifecycleDeploymentSchema>;
