import { z } from 'zod';
import { LifecycleDeploymentSchema, type LifecycleDeployment } from './aws-intent';
import { AWS_REGION_PATTERN } from './aws-config';
import { parseRebaseJson, RebaseDigest, RebaseTime } from './aws-rebase-json';

const version = z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/);
const ref = z.string().max(512).regex(/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/);
export const RebaseReleaseSchema = z.object({
    schemaVersion: z.literal(1), accountId: z.string().regex(/^[0-9]{12}$/), region: z.string().regex(AWS_REGION_PATTERN),
    namespace: z.string().regex(/^[a-z][a-z0-9]{0,20}$/), amiId: z.string().regex(/^ami-[0-9a-f]{17}$/),
    recipeVersion: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
        .refine(v => v.split('.').every(n => Number(n) <= 1073741823)),
    lowerImageDigest: RebaseDigest, lowerImageRef: ref, previousLowerImageDigest: RebaseDigest.nullable(), previousLowerImageRef: ref.nullable(),
    agentCommit: z.string().regex(/^[0-9a-f]{40}$/), stateMachineVersionArn: version,
    preparationStateMachineVersionArn: version, recoveryStateMachineVersionArn: version,
    launchTemplateId: z.string().regex(/^lt-[0-9a-f]{17}$/), launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/), createdAt: RebaseTime,
}).strict().superRefine((r, ctx) => {
    const fail = () => ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
    if (['identity', 'operators', 'operator', 'admin', 'root', 'ops', 'deploy', 'boundary', 'aws', 'service'].includes(r.namespace)) fail();
    if ((r.previousLowerImageDigest === null) !== (r.previousLowerImageRef === null) || r.lowerImageDigest === r.previousLowerImageDigest) fail();
    const repository = r.lowerImageRef.split('@')[0]!;
    if (!repository.startsWith(`${r.accountId}.dkr.ecr.${r.region}.amazonaws.com/`)
        || repository.split('.amazonaws.com/').length !== 2 || (r.previousLowerImageRef && r.previousLowerImageRef.split('@')[0] !== repository)) fail();
    for (const [field, name] of [['stateMachineVersionArn', 'lifecycle'], ['preparationStateMachineVersionArn', 'rebase-preparation'], ['recoveryStateMachineVersionArn', 'recovery']] as const) {
        const prefix = `arn:aws:states:${r.region}:${r.accountId}:stateMachine:ezil-${r.namespace}-${name}:`;
        if (!r[field].startsWith(prefix) || !/^[1-9][0-9]*$/.test(r[field].slice(prefix.length))) fail();
    }
});
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
