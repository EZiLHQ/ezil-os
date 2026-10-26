/**
 * Lifecycle intents for the AWS computer state machine (docs/AWS-COMPUTERS.md
 * C-1/C-3; infra/app-computers/lib/lifecycle/{deployment,intent,contract}.ts).
 *
 * The app starts ONE execution per operation on the region's pinned state
 * machine VERSION, named `computer-<jobId>`, whose input is the envelope
 * `{schemaVersion: 1, document, digest}`: `document` is the intent's JSON and
 * `digest` its sha256. The helper re-parses the document with the infra
 * schema, requires `deployment` to equal its own settings exactly, and asks
 * the app's authority endpoint before every mutation.
 *
 * 🔴 This file MIRRORS the infra schema (the app does not import infra code;
 * app CI installs no infra dependencies). `aws-intent.test.ts` pins the
 * built documents against `aws-intent.fixtures.json`, and infra's
 * `test/app-intent-contract.test.ts` parses every fixture with the real
 * `parseLifecycleWork`. A drift on either side fails one of the two.
 *
 * No AWS SDK and no network here: building an intent never starts anything.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { parseRebaseJson, RebaseDigest, RebaseHash, RebaseUuid } from './aws-rebase-json';

import { AWS_REGION_PATTERN, type Env } from './aws-config';
import { RebaseSourceReleaseSchema } from './aws-rebase-release';

/** JSON object: region → that region's lifecycle deployment (the infra stack's outputs). */
export const LIFECYCLE_DEPLOYMENTS_ENV = 'EZIL_AWS_LIFECYCLE_DEPLOYMENTS';

/**
 * Infra's closed allowlist (`INSTANCE_TYPES`, deployment.ts), in its order: every
 * type a tier may record, plus the benchmark type. A deployment may narrow it,
 * never extend it. aws-intent.test.ts checks that every tier type is listed.
 */
export const KNOWN_INSTANCE_TYPES: readonly string[] = ['t3a.medium', 't3.medium', 'm6i.large', 'c6i.xlarge', 'm6i.xlarge', 'm6i.2xlarge'];

const ZONE_ID_PATTERN = /^[a-z]{2,4}\d-az\d+$/;
const DIRECTION: Record<string, string> = {
    north: 'n', south: 's', east: 'e', west: 'w', central: 'c', northeast: 'ne', southeast: 'se', northwest: 'nw', southwest: 'sw',
};

/** ap-south-1 → aps1 (infra `zoneIdPrefix`). */
function zoneIdPrefix(region: string): string {
    const [geo, direction, number] = region.split('-') as [string, string, string];
    return `${geo}${DIRECTION[direction]}${number}`;
}

/** Infra `zoneIdMatchesRegion`. */
function zoneIdMatchesRegion(zoneId: string, region: string): boolean {
    return ZONE_ID_PATTERN.test(zoneId) && AWS_REGION_PATTERN.test(region) && zoneId.startsWith(`${zoneIdPrefix(region)}-az`);
}

/**
 * Infra `RESERVED_NAMESPACES` / `NamespaceSchema`: lowercase letters and digits
 * only (no '-', so `ezil-<ns>-*` never matches another namespace's names), and
 * never a name reserved for identity or operator resources.
 */
const RESERVED_NAMESPACES: readonly string[] = ['identity', 'operators', 'operator', 'admin', 'root', 'ops', 'deploy', 'boundary', 'aws', 'service'];
const NamespaceSchema = z
    .string()
    .regex(/^[a-z][a-z0-9]{0,20}$/)
    .refine((n) => !RESERVED_NAMESPACES.includes(n), { message: 'reserved_namespace' });

/** Infra `machineName`: the state machine's name inside a version ARN (`…:stateMachine:<name>:<version>`). */
const machineName = (versionArn: string) => versionArn.slice(0, versionArn.lastIndexOf(':')).split(':').at(-1) ?? '';

const StorageSchema = z
    .object({
        // Infra parity (deployment.ts StorageSchema): optional here and passed through
        // unchanged; infra applies its '/dev/sda1' default when it is absent.
        rootDeviceName: z.enum(['/dev/sda1', '/dev/xvda']).optional(),
        rootGiB: z.number().int().min(8).max(64),
        dataMinGiB: z.number().int().min(1).max(16384),
        dataMaxGiB: z.number().int().min(1).max(16384),
    })
    .strict()
    .refine((s) => s.dataMinGiB <= s.dataMaxGiB, { message: 'invalid_storage_range' });

export const LifecycleDeploymentSchema = z
    .object({
        accountId: z.string().regex(/^\d{12}$/),
        region: z.string().regex(AWS_REGION_PATTERN),
        zoneId: z.string().regex(ZONE_ID_PATTERN),
        subnetId: z.string().regex(/^subnet-[a-f0-9]{17}$/),
        securityGroupId: z.string().regex(/^sg-[a-f0-9]{17}$/),
        launchTemplateId: z.string().regex(/^lt-[a-f0-9]{17}$/),
        launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/),
        amiId: z.string().regex(/^ami-[a-f0-9]{17}$/),
        namespace: NamespaceSchema,
        instanceTypes: z
            .array(z.string().refine((t) => KNOWN_INSTANCE_TYPES.includes(t), { message: 'unknown_instance_type' }))
            .min(1)
            .max(KNOWN_INSTANCE_TYPES.length),
        storage: StorageSchema,
        dataKeyArn: z.string(),
        stateMachineVersionArn: z.string().max(300),
        lowerImageDigest: RebaseDigest.optional(),
        previousLowerImageDigest: RebaseDigest.nullable().optional(),
        preparationStateMachineVersionArn: z.string().max(300).optional(),
        recoveryStateMachineVersionArn: z.string().max(300).optional(),
    })
    .strict()
    // Same refinements as infra's LifecycleDeploymentSchema, in the same order.
    .superRefine((d, ctx) => {
        const tuple = [d.lowerImageDigest, d.previousLowerImageDigest, d.preparationStateMachineVersionArn, d.recoveryStateMachineVersionArn];
        if (tuple.some((v) => v !== undefined)) {
            if (tuple.some((v) => v === undefined) || d.lowerImageDigest === d.previousLowerImageDigest)
                ctx.addIssue({ code: 'custom', message: 'incomplete_image_deployment' });
            for (const [field, name] of [['stateMachineVersionArn', 'lifecycle'], ['preparationStateMachineVersionArn', 'rebase-preparation'], ['recoveryStateMachineVersionArn', 'recovery']] as const) {
                const prefix = `arn:aws:states:${d.region}:${d.accountId}:stateMachine:ezil-${d.namespace}-${name}:`;
                const arn = d[field];
                if (!arn?.startsWith(prefix) || !/^[1-9][0-9]*$/.test(arn.slice(prefix.length)))
                    ctx.addIssue({ code: 'custom', path: [field], message: 'invalid_deployment_reference' });
            }
        }
        if (!zoneIdMatchesRegion(d.zoneId, d.region)) ctx.addIssue({ code: 'custom', path: ['zoneId'], message: 'zone_not_in_region' });
        // Exec-role IAM scopes state machines to ezil-<ns>-* names.
        if (!machineName(d.stateMachineVersionArn).startsWith(`ezil-${d.namespace}-`))
            ctx.addIssue({ code: 'custom', path: ['stateMachineVersionArn'], message: 'machine_name_not_in_namespace' });
        if (new Set(d.instanceTypes).size !== d.instanceTypes.length) ctx.addIssue({ code: 'custom', path: ['instanceTypes'], message: 'duplicate_instance_type' });
        const matches = {
            dataKeyArn: new RegExp(`^arn:aws:kms:${d.region}:${d.accountId}:key/[a-f0-9-]{36}$`),
            stateMachineVersionArn: new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`),
        };
        for (const [field, pattern] of Object.entries(matches)) {
            if (!pattern.test(d[field as keyof typeof matches])) ctx.addIssue({ code: 'custom', path: [field], message: 'invalid_deployment_reference' });
        }
    });
export type LifecycleDeployment = z.infer<typeof LifecycleDeploymentSchema>;

/** Legacy source deployments carry the observed lower but cannot authorize a launch. */
export const SourceLifecycleDeploymentSchema = LifecycleDeploymentSchema.innerType().extend({
    preparationStateMachineVersionArn: z.string().max(300).nullable().optional(),
    recoveryStateMachineVersionArn: z.string().max(300).nullable().optional(),
}).superRefine((d, ctx) => {
    const legacy = d.preparationStateMachineVersionArn === null || d.recoveryStateMachineVersionArn === null;
    const { lowerImageDigest, previousLowerImageDigest, preparationStateMachineVersionArn, recoveryStateMachineVersionArn, ...base } = d;
    if (!(legacy ? LifecycleDeploymentSchema.safeParse(base) : LifecycleDeploymentSchema.safeParse(d)).success
        || (legacy && (!lowerImageDigest || previousLowerImageDigest === undefined || preparationStateMachineVersionArn === undefined || recoveryStateMachineVersionArn === undefined
            || lowerImageDigest === previousLowerImageDigest)))
        ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
    if (legacy) for (const [arn, name] of [[preparationStateMachineVersionArn, 'rebase-preparation'], [recoveryStateMachineVersionArn, 'recovery']] as const) {
        if (arn !== null && (typeof arn !== 'string' || !new RegExp(`^arn:aws:states:${d.region}:${d.accountId}:stateMachine:ezil-${d.namespace}-${name}:[1-9][0-9]*$`).test(arn)))
            ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
    }
});
export type SourceLifecycleDeployment = z.infer<typeof SourceLifecycleDeploymentSchema>;

/**
 * Every configured region's deployment, or the reason none is usable.
 * A configured region with no deployment, or one whose `region` differs from
 * its key, fails the whole read: never a partial map.
 */
export function readLifecycleDeployments(
    env: Env,
    regions: readonly string[],
): { ok: true; deployments: Record<string, LifecycleDeployment> } | { ok: false; invalid: string[] } {
    const raw = env[LIFECYCLE_DEPLOYMENTS_ENV];
    let parsed: unknown;
    try {
        parsed = raw === undefined ? undefined : parseRebaseJson(raw, 65536);
    } catch {
        return { ok: false, invalid: [LIFECYCLE_DEPLOYMENTS_ENV] };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, invalid: [LIFECYCLE_DEPLOYMENTS_ENV] };
    const deployments: Record<string, LifecycleDeployment> = {};
    const invalid: string[] = [];
    for (const region of regions) {
        const entry = Object.prototype.hasOwnProperty.call(parsed, region) ? (parsed as Record<string, unknown>)[region] : undefined;
        const { releases, ...deployment } = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
        if (releases !== undefined && !z.array(RebaseSourceReleaseSchema).min(1).max(16).safeParse(releases).success) {
            invalid.push(`${LIFECYCLE_DEPLOYMENTS_ENV}.${region}`); continue;
        }
        const d = LifecycleDeploymentSchema.safeParse(deployment);
        if (!d.success || d.data.region !== region) invalid.push(`${LIFECYCLE_DEPLOYMENTS_ENV}.${region}`);
        else deployments[region] = d.data;
    }
    return invalid.length > 0 ? { ok: false, invalid } : { ok: true, deployments };
}

export const LIFECYCLE_OPERATIONS = ['provision', 'start', 'stop', 'replace', 'retire', 'pool-provision', 'adopt', 'release', 'pool-retire'] as const;
/** Matches infra's pool intent allowlist for the approved paid sizes. */
export const POOL_LIFECYCLE_TYPES = ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'] as const;
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];

const uuid = RebaseUuid;
const positive = z.number().int().min(1).max(2147483647);
const instance = z.string().regex(/^i-[a-f0-9]{17}$/);
const volume = z.string().regex(/^vol-[a-f0-9]{17}$/);
const base64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$|^(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;

export const RebasePreparationReferenceSchema = z.object({
    v: z.literal(1), preparationJobId: RebaseUuid,
    executionArn: z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-[0-9a-f-]{36}$/), digest: RebaseHash,
}).strict();

/** Field order is the document's key order (it is part of the pinned fixtures). */
export const LifecycleIntentSchema = z
    .object({
        schemaVersion: z.literal(1),
        jobId: uuid,
        computerId: uuid,
        revision: positive,
        operation: z.enum(LIFECYCLE_OPERATIONS),
        targetGeneration: positive,
        fenceToken: uuid,
        poolHostId: uuid.optional(),
        poolGeneration: positive.optional(),
        providerInstanceId: instance.nullable(),
        dataVolumeId: volume.nullable(),
        previousGeneration: positive.nullable(),
        previousInstanceId: instance.nullable(),
        previousFenceToken: uuid.nullable(),
        deployment: LifecycleDeploymentSchema,
        instanceType: z.string().refine((t) => KNOWN_INSTANCE_TYPES.includes(t), { message: 'unknown_instance_type' }),
        dataVolumeGiB: z.number().int().min(1).max(16384).nullable(),
        leaseEpoch: positive,
        userData: z.string().max(4096).regex(base64).nullable(),
        rebasePreparation: RebasePreparationReferenceSchema.optional(),
    })
    .strict()
    // Same rule set as the infra refine, in the same order.
    .refine((i) => {
        const pool = ['pool-provision', 'pool-retire', 'adopt', 'release'].includes(i.operation);
        if (pool && !(POOL_LIFECYCLE_TYPES as readonly string[]).includes(i.instanceType)) return false;
        if (['pool-provision', 'pool-retire', 'adopt'].includes(i.operation) !== (i.poolHostId !== undefined)) return false;
        if (['pool-provision', 'pool-retire'].includes(i.operation) !== (i.poolGeneration !== undefined)) return false;
        if (['provision', 'replace'].includes(i.operation) !== (i.userData !== null) && i.operation !== 'start') return false;
        if (!i.deployment.instanceTypes.includes(i.instanceType)) return false;
        if ((i.operation === 'provision' || (i.operation === 'adopt' && i.dataVolumeId === null)) !== (i.dataVolumeGiB !== null)) return false;
        if (i.dataVolumeGiB !== null && (i.dataVolumeGiB < i.deployment.storage.dataMinGiB || i.dataVolumeGiB > i.deployment.storage.dataMaxGiB)) return false;
        if (i.operation === 'replace') {
            return (
                i.providerInstanceId === null &&
                i.dataVolumeId !== null &&
                i.previousGeneration !== null &&
                i.previousGeneration < i.targetGeneration &&
                i.previousInstanceId !== null &&
                i.previousFenceToken !== null &&
                i.previousFenceToken !== i.fenceToken
            );
        }
        if (i.previousGeneration !== null || i.previousInstanceId !== null || i.previousFenceToken !== null) return false;
        if (i.operation === 'pool-provision' || i.operation === 'pool-retire') return i.dataVolumeId === null
            && (i.operation === 'pool-provision' ? i.providerInstanceId === null : i.providerInstanceId !== null)
            && i.computerId === i.poolHostId && i.targetGeneration === i.poolGeneration;
        if (i.operation === 'adopt') return i.providerInstanceId !== null;
        return i.operation === 'provision' ? i.providerInstanceId === null && i.dataVolumeId === null : i.providerInstanceId !== null && i.dataVolumeId !== null;
    }, { message: 'lifecycle_intent_invalid' })
    .superRefine((i, ctx) => {
        const fail = () => ctx.addIssue({ code: 'custom', message: 'lifecycle_lease_invalid' });
        try {
            if (i.userData === null) { if (i.rebasePreparation) fail(); return; }
            const l = parseEnrollmentUserData(i.userData);
            if (l.computerId !== i.computerId || l.generation !== i.targetGeneration || l.leaseEpoch !== i.leaseEpoch
                || l.provision !== (i.operation === 'provision') || (l.volumeId ?? null) !== i.dataVolumeId) fail();
            const permit = l.rebasePermit ?? l.ebsRestore;
            if (!!permit !== !!i.rebasePreparation) fail();
            if (permit) {
                const ref = i.rebasePreparation;
                const d = i.deployment;
                if (i.operation !== 'replace' || !ref || !d.lowerImageDigest || !d.preparationStateMachineVersionArn
                    || permit.launchJobId !== i.jobId || permit.fenceToken !== i.fenceToken
                    || permit.preparationJobId !== ref.preparationJobId
                    || ref.executionArn !== `arn:aws:states:${d.region}:${d.accountId}:execution:ezil-${d.namespace}-rebase-preparation:computer-${ref.preparationJobId}`) fail();
                if (l.rebase && (l.rebase.fromDigest !== d.previousLowerImageDigest || l.rebase.toDigest !== d.lowerImageDigest)) fail();
                if (l.ebsRestore && (l.ebsRestore.fromDigest !== d.lowerImageDigest || l.ebsRestore.sourceGeneration !== i.previousGeneration)) fail();
            }
        } catch { fail(); }
    });
export type LifecycleIntent = z.infer<typeof LifecycleIntentSchema>;

export class LifecycleIntentInvalidError extends Error {
    constructor() {
        super('lifecycle_intent_invalid');
        this.name = 'LifecycleIntentInvalidError';
    }
}

/** What the app hands to `StartExecution`, and keeps to answer the authority callback. */
export interface LifecycleWork {
    intent: LifecycleIntent;
    /** Exact execution input: `{"schemaVersion":1,"document":…,"digest":…}`. */
    input: string;
    digest: string;
    /** `computer-<jobId>`: the helper refuses any other name. */
    name: string;
    /** The pinned VERSION ARN, never the unqualified machine or an alias. */
    stateMachineArn: string;
}

/**
 * A lifecycle job on a placement's CURRENT generation: start, stop or retire. Its fence
 * token is the one that generation's instance and volume are tagged with: the helper
 * refuses any other (`lifecycle_volume_invalid`), so it is never re-minted. A retire
 * keeps the data volume (R11): the helper stops and terminates the instance only.
 */
export function currentGenerationIntent(
    p: { computerId: string; generation: number; fenceToken: string | null; instanceId: string | null; volumeId: string | null; instanceType: string | null },
    operation: Extract<LifecycleOperation, 'start' | 'stop' | 'retire'>,
    deployment: LifecycleDeployment,
    extra: { jobId: string; userData: string | null; leaseEpoch: number },
): LifecycleIntent {
    return {
        schemaVersion: 1,
        jobId: extra.jobId,
        computerId: p.computerId.toLowerCase(),
        revision: 1,
        operation,
        targetGeneration: p.generation,
        fenceToken: p.fenceToken!,
        providerInstanceId: p.instanceId,
        dataVolumeId: p.volumeId,
        previousGeneration: null,
        previousInstanceId: null,
        previousFenceToken: null,
        deployment,
        instanceType: p.instanceType ?? '',
        dataVolumeGiB: null,
        leaseEpoch: extra.leaseEpoch,
        userData: extra.userData,
    };
}

/** Validate, serialize and digest one intent. Throws `LifecycleIntentInvalidError` rather than send a document the helper would refuse. */
export function buildLifecycleWork(candidate: LifecycleIntent): LifecycleWork {
    const pool = ['pool-provision', 'adopt', 'release', 'pool-retire'].includes(candidate.operation);
    const parsed = LifecycleIntentSchema.safeParse(pool ? { ...candidate, deployment: { ...candidate.deployment,
        storage: { rootDeviceName: '/dev/sda1', ...candidate.deployment.storage } } } : candidate);
    if (!parsed.success) throw new LifecycleIntentInvalidError();
    const intent = parsed.data;
    const document = JSON.stringify(intent);
    const digest = createHash('sha256').update(document, 'utf8').digest('hex');
    if (Buffer.byteLength(document) > 16384) throw new LifecycleIntentInvalidError();
    const input = JSON.stringify({ schemaVersion: 1, document, digest });
    if (Buffer.byteLength(input) > 20000) throw new LifecycleIntentInvalidError();
    return {
        intent,
        input,
        digest,
        name: `computer-${intent.jobId}`,
        stateMachineArn: intent.deployment.stateMachineVersionArn,
    };
}
