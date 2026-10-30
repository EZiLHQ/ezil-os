import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, type LifecycleIntent } from './intent.js';
import { parseLease } from './lease.js';

// Infrastructure pins are shared by the workflow; adding a computer never
// redeploys this graph. R5: there is no per-writer instance profile and no
// iam:PassRole. Hosts run without an instance role (see README "Host role").
/** C-6 nonce delivery to a stopped instance needs ModifyInstanceAttribute
 * (userData only). Both default off. `userDataNonce` enables the graph step and
 * helper decision; the IAM fence is narrowed from an unconditional Deny to a
 * userData-only Deny exception only when `userDataAttributeKeyVerified` is also
 * set, after staging proves how `ec2:Attribute` evaluates (README). */
export const FeaturesSchema = z.object({ userDataNonce: z.boolean().default(false),
    userDataAttributeKeyVerified: z.boolean().default(false) }).strict();
export const SettingsSchema = z.object({ deployment: LifecycleDeploymentSchema,
    authorityOrigin: z.string(), authoritySecretArn: z.string(), features: FeaturesSchema.default({}) }).strict().superRefine((s,ctx)=>{
    const d=s.deployment;
    if(!/^https:\/\/(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/.test(s.authorityOrigin)
        // The boundary lets bounded roles read only secrets named ezil/<ns>/*.
        ||!new RegExp(`^arn:aws:secretsmanager:${d.region}:${d.accountId}:secret:ezil/${d.namespace}/[A-Za-z0-9/_+=.@-]{1,480}-[A-Za-z0-9]{6}$`).test(s.authoritySecretArn)){
        ctx.addIssue({code:'custom',message:'invalid_lifecycle_settings'});
    }
});
export type Settings = z.infer<typeof SettingsSchema>;
export const canonical = (v: unknown): string => JSON.stringify(v, (_key,value:unknown) => value && typeof value==='object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)) : value);
export const equal = (a:unknown,b:unknown) => canonical(a)===canonical(b);
export const EnvelopeSchema = z.object({schemaVersion:z.literal(1),document:z.string().max(16384),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const token = (digest:string,kind:'volume'|'instance') => createHash('sha256').update(`ezil-lifecycle-v1\n${kind}\n${digest}`).digest('hex');
export const tagsFor = (i:LifecycleIntent,generation=i.targetGeneration,fence=i.fenceToken) => ({
    'ezil:managed-by':'app-computer-platform','ezil:stage':i.deployment.namespace,
    'ezil:computer-id':i.computerId,'ezil:generation':String(generation),'ezil:fence-token':fence,
});
/** Retagging an existing volume may change only these keys. Identity keys
 * (computer-id, managed-by, stage) are set once, at creation (ec2:CreateAction). */
export const RETAG_KEYS = ['ezil:generation','ezil:fence-token'] as const;
export const retagsFor = (i:LifecycleIntent) => ({'ezil:generation':String(i.targetGeneration),'ezil:fence-token':i.fenceToken});
export { POOL_INSTANCE_TYPES as POOL_IAM_TYPES } from './deployment.js';
export const POOL_CLAIM_KEYS = ['ezil:computer','ezil:generation','ezil:fence'] as const;
export const poolTagsFor = (i:LifecycleIntent) => ({
    'ezil:managed-by':'app-computer-platform','ezil:stage':i.deployment.namespace,
    'ezil:namespace':i.deployment.namespace,'ezil:pool':'1','ezil:pool-host':i.poolHostId!,
});
export const claimTagsFor = (i:LifecycleIntent) => ({
    'ezil:computer':i.computerId,'ezil:generation':String(i.targetGeneration),'ezil:fence':i.fenceToken,
});
export const poolLease = (i:LifecycleIntent) => Buffer.from(JSON.stringify({
    kind:'pool',poolHostId:i.poolHostId,poolGeneration:i.poolGeneration,
})).toString('base64');
export const tagList = (tags:Record<string,string>) => Object.entries(tags).map(([Key,Value])=>({Key,Value}));
/** DLM (I6) snapshots data volumes carrying this tag, valued with the
 * namespace. Set only at creation; root disks never carry it. */
export const BACKUP_TAG='ezil:backup';
export const initialVolumeTags = (i:LifecycleIntent,digest:string) => ({...tagsFor(i),'ezil:allocation':token(digest,'volume'),[BACKUP_TAG]:i.deployment.namespace});
export const AUTHORITY_PATH='/api/internal/computers/lifecycle-authority';
export const authorityFor=(i:LifecycleIntent,digest:string)=>({schemaVersion:1,computerId:i.computerId,jobId:i.jobId,leaseEpoch:i.leaseEpoch,digest,
    ...(i.rebasePreparation ? { imageJobId: i.rebasePreparation.preparationJobId,
        imageJobPhase: parseLease(i.userData!).ebsRestore ? 'rebind' : 'launch' } : {}),
    ...(['pool-provision','pool-retire'].includes(i.operation)?{operation:i.operation,poolHostId:i.poolHostId,poolGeneration:i.poolGeneration}:{})});
export const phases=['initial','volume','stopped','terminated','instance','tagged','attached','userdata','started','detached','claimed','unpooled'] as const;
export type Phase=typeof phases[number];
/** `runBurstableInstances` is RunInstances for a T-family type: the same EC2
 * API, but its graph state also forwards CreditSpecification (standard). A
 * separate state keeps every forwarded key mandatory in the fixed graph. */
export type Action='createVolume'|'runInstances'|'runBurstableInstances'|'attachVolume'|'detachVolume'|'createTags'|'claimInstance'|'deleteTags'|'modifyInstanceAttribute'|'startInstances'|'stopInstances'|'terminateInstances';
export const afterAction:Record<Action,Phase>={createVolume:'volume',runInstances:'instance',runBurstableInstances:'instance',attachVolume:'attached',
    modifyInstanceAttribute:'userdata',createTags:'tagged',claimInstance:'claimed',deleteTags:'unpooled',detachVolume:'detached',startInstances:'started',stopInstances:'stopped',terminateInstances:'terminated'};
/** Graph states that call RunInstances. Recovery treats entering ANY of them
 * as evidence that a launch may have happened. */
export const LAUNCH_ACTIONS:readonly Action[]=['runInstances','runBurstableInstances'];
/** The EC2 API each graph action calls (aws-sdk:ec2:<api>). */
export const ec2Api=(action:Action)=>action==='runBurstableInstances'?'runInstances':action==='claimInstance'?'createTags':action;
