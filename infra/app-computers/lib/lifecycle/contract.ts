import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, type LifecycleIntent } from './intent.js';

// Infrastructure pins are shared by the workflow; adding a computer never
// redeploys this graph. R5: there is no per-writer instance profile and no
// iam:PassRole. Hosts run without an instance role (see README "Host role").
export const SettingsSchema = z.object({ deployment: LifecycleDeploymentSchema,
    authorityOrigin: z.string(), authoritySecretArn: z.string() }).strict().superRefine((s,ctx)=>{
    const d=s.deployment;
    if(!/^https:\/\/(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/.test(s.authorityOrigin)
        ||!new RegExp(`^arn:aws:secretsmanager:${d.region}:${d.accountId}:secret:[A-Za-z0-9/_+=.@-]{1,512}-[A-Za-z0-9]{6}$`).test(s.authoritySecretArn)){
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
export const tagList = (tags:Record<string,string>) => Object.entries(tags).map(([Key,Value])=>({Key,Value}));
export const initialVolumeTags = (i:LifecycleIntent,digest:string) => ({...tagsFor(i),'ezil:allocation':token(digest,'volume')});
export const AUTHORITY_PATH='/api/internal/computers/lifecycle-authority';
export const authorityFor=(i:LifecycleIntent,digest:string)=>({schemaVersion:1,computerId:i.computerId,jobId:i.jobId,digest});
export const phases=['initial','volume','stopped','terminated','instance','tagged','attached','started'] as const;
export type Phase=typeof phases[number];
export type Action='createVolume'|'runInstances'|'attachVolume'|'createTags'|'startInstances'|'stopInstances'|'terminateInstances';
export const afterAction:Record<Action,Phase>={createVolume:'volume',runInstances:'instance',attachVolume:'attached',
    createTags:'tagged',startInstances:'started',stopInstances:'stopped',terminateInstances:'terminated'};
