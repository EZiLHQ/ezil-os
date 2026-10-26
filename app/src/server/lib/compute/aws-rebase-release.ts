import { z } from 'zod';
import { LifecycleDeploymentSchema, SourceLifecycleDeploymentSchema, type SourceLifecycleDeployment, type LifecycleDeployment } from './aws-intent';
import { AWS_REGION_PATTERN } from './aws-config';
import { parseRebaseJson, RebaseDigest, RebaseTime } from './aws-rebase-json';

const version = z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/);
const ref = z.string().max(512).regex(/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/);
const releaseObject = z.object({
    schemaVersion: z.literal(1), accountId: z.string().regex(/^[0-9]{12}$/), region: z.string().regex(AWS_REGION_PATTERN),
    namespace: z.string().regex(/^[a-z][a-z0-9]{0,20}$/), amiId: z.string().regex(/^ami-[0-9a-f]{17}$/),
    recipeVersion: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
        .refine(v => v.split('.').every(n => Number(n) <= 1073741823)),
    lowerImageDigest: RebaseDigest, lowerImageRef: ref, previousLowerImageDigest: RebaseDigest.nullable(), previousLowerImageRef: ref.nullable(),
    agentCommit: z.string().regex(/^[0-9a-f]{40}$/), stateMachineVersionArn: version,
    preparationStateMachineVersionArn: version, recoveryStateMachineVersionArn: version,
    launchTemplateId: z.string().regex(/^lt-[0-9a-f]{17}$/), launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/), createdAt: RebaseTime,
}).strict();
function refineRelease(r: z.infer<typeof sourceObject>, ctx: z.RefinementCtx) {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
    if (['identity', 'operators', 'operator', 'admin', 'root', 'ops', 'deploy', 'boundary', 'aws', 'service'].includes(r.namespace)) fail();
    if ((r.previousLowerImageDigest === null) !== (r.previousLowerImageRef === null) || r.lowerImageDigest === r.previousLowerImageDigest) fail();
    const repository = r.lowerImageRef.split('@')[0]!;
    if (!repository.startsWith(`${r.accountId}.dkr.ecr.${r.region}.amazonaws.com/`)
        || repository.split('.amazonaws.com/').length !== 2 || (r.previousLowerImageRef && r.previousLowerImageRef.split('@')[0] !== repository)) fail();
    for (const [field, name] of [['stateMachineVersionArn', 'lifecycle'], ['preparationStateMachineVersionArn', 'rebase-preparation'], ['recoveryStateMachineVersionArn', 'recovery']] as const) {
        const prefix = `arn:aws:states:${r.region}:${r.accountId}:stateMachine:ezil-${r.namespace}-${name}:`;
        if (r[field] !== null && (!r[field]!.startsWith(prefix) || !/^[1-9][0-9]*$/.test(r[field]!.slice(prefix.length)))) fail();
    }
}
const sourceObject = releaseObject.extend({ preparationStateMachineVersionArn: version.nullable(), recoveryStateMachineVersionArn: version.nullable() });
export const RebaseReleaseSchema = releaseObject.superRefine(refineRelease);
export const RebaseSourceReleaseSchema = sourceObject.superRefine(refineRelease);
export type RebaseSourceRelease = z.infer<typeof RebaseSourceReleaseSchema>;
export type RebaseRelease = z.infer<typeof RebaseReleaseSchema>;

/** Approved repository is supplied by reviewed operator evidence, never an inferred registry digest. */
export function parseRebaseRelease(raw: unknown, deployment: LifecycleDeployment, approvedRepositoryUri: string): RebaseRelease {
    const r = RebaseReleaseSchema.parse(typeof raw === 'string' ? parseRebaseJson(raw) : raw);
    if (Buffer.byteLength(JSON.stringify(r)) > 16384) throw new Error('release_mismatch');
    const d = LifecycleDeploymentSchema.parse(deployment);
    const keys = ['accountId', 'region', 'namespace', 'amiId', 'lowerImageDigest', 'previousLowerImageDigest', 'stateMachineVersionArn',
        'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn', 'launchTemplateId', 'launchTemplateVersion'] as const;
    if (keys.some(k => r[k] !== d[k]) || r.lowerImageRef.split('@')[0] !== approvedRepositoryUri) throw new Error('release_mismatch');
    return r;
}

/** Validate registry evidence before deciding whether the source needs an EC2 observation. */
function rebaseReleaseCandidates(entry: unknown, lowerImageDigest: string | null) {
    if (lowerImageDigest === null) throw new Error('source_digest_unknown');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('release_mismatch');
    const { releases, ...rawDeployment } = entry as Record<string, unknown>;
    const deployment = LifecycleDeploymentSchema.parse(rawDeployment);
    const records = z.array(RebaseSourceReleaseSchema).min(1).max(16).parse(releases);
    if (records.some((r, i) => i > 0 && Date.parse(r.createdAt) < Date.parse(records[i - 1]!.createdAt))) throw new Error('release_mismatch');
    const targetKeys = ['accountId', 'region', 'namespace', 'amiId', 'launchTemplateId', 'launchTemplateVersion', 'stateMachineVersionArn',
        'lowerImageDigest', 'previousLowerImageDigest', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const;
    const targets = records.filter(r => targetKeys.every(k => r[k] === deployment[k]));
    const sources = records.filter(r => r.lowerImageDigest === lowerImageDigest);
    if (targets.length !== 1 || sources.length === 0) throw new Error('release_mismatch');
    const target = RebaseReleaseSchema.parse(targets[0]);
    const repository = target.lowerImageRef.split('@')[0]!;
    return { sources, target, deployment, repository };
}

export function rebaseSourceRequiresAmi(entry: unknown, lowerImageDigest: string | null): boolean {
    return rebaseReleaseCandidates(entry, lowerImageDigest).sources.length > 1;
}

/** A1/B2: an AMI is provider evidence, never HTTP input; a unique lower needs no observation. */
export function resolveRebaseReleases(entry: unknown, lowerImageDigest: string | null, observedSourceAmiId?: string) {
    const { sources, target, deployment, repository } = rebaseReleaseCandidates(entry, lowerImageDigest);
    const matches = sources.length > 1 ? sources.filter(r => r.amiId === observedSourceAmiId) : sources;
    if (matches.length !== 1) throw new Error('release_mismatch');
    const source = matches[0]!;
    if (source.accountId !== target.accountId || source.region !== target.region || source.namespace !== target.namespace
        || source.lowerImageRef.split('@')[0] !== repository) throw new Error('release_mismatch');
    if (target.previousLowerImageDigest !== lowerImageDigest) throw new Error('unsupported_predecessor');
    return { source, target, deployment, repository };
}

export function parseRebaseSourceRelease(raw: unknown, deployment: SourceLifecycleDeployment, repository: string): RebaseSourceRelease {
    const r = RebaseSourceReleaseSchema.parse(typeof raw === 'string' ? parseRebaseJson(raw) : raw);
    const d = SourceLifecycleDeploymentSchema.parse(deployment);
    if (Buffer.byteLength(JSON.stringify(r)) > 16384 || r.lowerImageRef.split('@')[0] !== repository
        || (['accountId', 'region', 'namespace', 'amiId', 'lowerImageDigest', 'previousLowerImageDigest', 'stateMachineVersionArn',
            'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn', 'launchTemplateId', 'launchTemplateVersion'] as const).some(k => r[k] !== d[k])) throw new Error('release_mismatch');
    return r;
}
export function sourceDeploymentFor(d: LifecycleDeployment, r: RebaseSourceRelease): SourceLifecycleDeployment {
    return SourceLifecycleDeploymentSchema.parse({ ...d, amiId: r.amiId, launchTemplateId: r.launchTemplateId,
        launchTemplateVersion: r.launchTemplateVersion, stateMachineVersionArn: r.stateMachineVersionArn,
        lowerImageDigest: r.lowerImageDigest, previousLowerImageDigest: r.previousLowerImageDigest,
        preparationStateMachineVersionArn: r.preparationStateMachineVersionArn, recoveryStateMachineVersionArn: r.recoveryStateMachineVersionArn });
}
