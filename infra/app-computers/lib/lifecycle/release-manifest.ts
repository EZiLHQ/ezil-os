import { z } from 'zod';
import { LifecycleDeploymentSchema, NamespaceSchema, REGION_PATTERN, type LifecycleDeployment } from './deployment.js';
import { DIGEST, TIME, strictJson } from './strict-json.js';

const version = z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/);
const ref = z.string().max(512).regex(/^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/);
export const RELEASE_WORKFLOW_KEYS = ['stateMachineVersionArn', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const;
const schema = z.object({
    schemaVersion: z.literal(1), accountId: z.string().regex(/^[0-9]{12}$/), region: z.string().regex(REGION_PATTERN), namespace: NamespaceSchema,
    amiId: z.string().regex(/^ami-[0-9a-f]{17}$/), recipeVersion: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/)
        .refine(v => v.split('.').every(n => Number(n) <= 1073741823)),
    lowerImageDigest: DIGEST, lowerImageRef: ref, previousLowerImageDigest: DIGEST.nullable(), previousLowerImageRef: ref.nullable(),
    agentCommit: z.string().regex(/^[0-9a-f]{40}$/), stateMachineVersionArn: version,
    preparationStateMachineVersionArn: version.nullable(), recoveryStateMachineVersionArn: version.nullable(),
    launchTemplateId: z.string().regex(/^lt-[0-9a-f]{17}$/), launchTemplateVersion: z.string().regex(/^[1-9][0-9]{0,9}$/), createdAt: TIME,
}).strict();
export type ReleaseManifest = z.infer<typeof schema>;

/** Source-only null workflow references are amendment A1 legacy records. They
 * can never authorize maintenance or a target. Registry digests intentionally
 * need not equal baked lower IDs (classic and containerd stores differ). */
export function parseReleaseManifest(raw: string, deployment: LifecycleDeployment, approvedRepositoryUri: string,
    mode: 'target' | 'source' | 'maintenance' = 'target'): ReleaseManifest {
    const r = schema.parse(strictJson(raw, 16384)), d = LifecycleDeploymentSchema.parse(deployment);
    const fail = (): never => { throw new Error('release_mismatch'); };
    const repository = r.lowerImageRef.split('@')[0]!;
    if (repository !== approvedRepositoryUri || !repository.startsWith(`${r.accountId}.dkr.ecr.${r.region}.amazonaws.com/`)
        || repository.split('.amazonaws.com/').length !== 2 || (r.previousLowerImageRef && r.previousLowerImageRef.split('@')[0] !== repository)
        || (r.previousLowerImageDigest === null) !== (r.previousLowerImageRef === null) || r.lowerImageDigest === r.previousLowerImageDigest
        || (mode === 'target' && r.previousLowerImageDigest === null)
        || (mode !== 'source' && (!r.preparationStateMachineVersionArn || !r.recoveryStateMachineVersionArn))) return fail();
    const names = ['lifecycle', 'rebase-preparation', 'recovery'];
    for (const [index, key] of RELEASE_WORKFLOW_KEYS.entries()) {
        const value = r[key]; if (value === null && mode === 'source') continue;
        const prefix = `arn:aws:states:${r.region}:${r.accountId}:stateMachine:ezil-${r.namespace}-${names[index]}:`;
        if (!value?.startsWith(prefix) || !/^[1-9][0-9]*$/.test(value.slice(prefix.length))) return fail();
    }
    for (const key of ['accountId', 'region', 'namespace', 'amiId', 'stateMachineVersionArn', 'launchTemplateId', 'launchTemplateVersion'] as const)
        if (r[key] !== d[key]) return fail();
    for (const key of ['lowerImageDigest', 'previousLowerImageDigest', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const) {
        if (mode === 'source' && (r[key] === null || d[key] === undefined)) continue;
        if (r[key] !== d[key]) return fail();
    }
    return r;
}

/** Offline validation of E's complete readback bundle. These functions perform
 * no SDK calls: the lead supplies the reviewed request/artifact identities. */
export function validateReleaseReadback(r: ReleaseManifest, evidence: unknown, reviewed: {
    buildArn: string; recipeName: string; agentSourceS3Uri: string; now: number;
}): void {
    const fail = (): never => { throw new Error('release_mismatch'); };
    if (!Number.isFinite(reviewed.now) || Date.parse(r.createdAt) > reviewed.now
        || !new RegExp(`^arn:aws:imagebuilder:${r.region}:${r.accountId}:image/[a-z0-9-]+/[0-9]+\\.[0-9]+\\.[0-9]+/[0-9]+$`).test(reviewed.buildArn)
        || !/^s3:\/\/[a-z0-9][a-z0-9.-]+\/[A-Za-z0-9/_-]+\.tgz$/.test(reviewed.agentSourceS3Uri)
        || !reviewed.agentSourceS3Uri.endsWith('/host-agent-' + r.agentCommit + '.tgz')) return fail();
    const e = z.object({ build: z.record(z.unknown()), image: z.record(z.unknown()), template: z.record(z.unknown()),
        versions: z.record(z.unknown()), workflows: z.record(z.unknown()) }).strict().parse(evidence);
    const build = z.object({ arn: z.string(), state: z.object({ status: z.literal('AVAILABLE') }).passthrough(),
        outputResources: z.object({ amis: z.array(z.object({ image: z.string(), region: z.string(), accountId: z.string() }).passthrough()).length(1) }).passthrough(),
        imageRecipe: z.object({ name: z.string(), version: z.string(), components: z.array(z.object({ parameters:
            z.array(z.object({ name: z.string(), value: z.array(z.string().nullable()).length(1) }).strict()) }).passthrough()).length(1) }).passthrough(),
    }).passthrough().parse(e.build.image);
    const ami = build.outputResources.amis[0]!;
    if (build.arn !== reviewed.buildArn || build.imageRecipe.name !== reviewed.recipeName || build.imageRecipe.version !== r.recipeVersion
        || ami.image !== r.amiId || ami.region !== r.region || ami.accountId !== r.accountId) return fail();
    const params = build.imageRecipe.components[0]!.parameters;
    if (new Set(params.map(p => p.name)).size !== params.length) return fail();
    for (const [name, value] of Object.entries({ DesktopImageRef: r.lowerImageRef, DesktopImageId: r.lowerImageDigest,
        PreviousDesktopImageRef: r.previousLowerImageRef, PreviousDesktopImageId: r.previousLowerImageDigest, AgentSrcS3Uri: reviewed.agentSourceS3Uri }))
        if (params.find(p => p.name === name)?.value[0] !== value) return fail();
    const image = z.object({ Images: z.array(z.object({ ImageId: z.string(), OwnerId: z.string(), State: z.literal('available'),
        Architecture: z.literal('x86_64'), Public: z.literal(false) }).passthrough()).length(1), NextToken: z.undefined() }).passthrough().parse(e.image).Images[0]!;
    if (image.ImageId !== r.amiId || image.OwnerId !== r.accountId) return fail();
    const template = z.object({ LaunchTemplateVersions: z.array(z.object({ LaunchTemplateId: z.string(), VersionNumber: z.number().int().positive(),
        LaunchTemplateData: z.object({ ImageId: z.string() }).passthrough() }).passthrough()).length(1), NextToken: z.undefined() }).passthrough().parse(e.template).LaunchTemplateVersions[0]!;
    if (template.LaunchTemplateId !== r.launchTemplateId || String(template.VersionNumber) !== r.launchTemplateVersion || template.LaunchTemplateData.ImageId !== r.amiId) return fail();
    for (const key of RELEASE_WORKFLOW_KEYS) {
        const arn = r[key]; if (arn === null) continue;
        const versions = z.object({ stateMachineVersions: z.array(z.object({ stateMachineVersionArn: z.string() }).passthrough()), nextToken: z.undefined() }).passthrough().parse(e.versions[key]);
        const workflow = z.object({ stateMachineArn: z.string(), type: z.literal('STANDARD'), status: z.literal('ACTIVE') }).passthrough().parse(e.workflows[key]);
        if (versions.stateMachineVersions.filter(v => v.stateMachineVersionArn === arn).length !== 1
            || ![arn, arn.replace(/:[1-9][0-9]*$/, '')].includes(workflow.stateMachineArn)) return fail();
    }
}
