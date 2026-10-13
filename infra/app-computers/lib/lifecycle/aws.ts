import { createHash, createHmac } from 'node:crypto';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, DescribeImagesCommand, DescribeLaunchTemplateVersionsCommand,
    type EC2ClientConfig, type Instance, type Volume, type Image, type LaunchTemplateVersion } from '@aws-sdk/client-ec2';
import { SFNClient, DescribeExecutionCommand, type DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AUTHORITY_PATH, authorityFor, canonical, equal, token, type Settings } from './contract.js';
import type { LifecycleIntent } from './intent.js';

export interface Dependencies {
    execution(arn:string):Promise<DescribeExecutionOutput>;
    authority(i:LifecycleIntent,digest:string):Promise<boolean>;
    instances(ids:string[]|{token:string}):Promise<{instance:Instance;owner:string|undefined}[]>;
    volumes(ids:string[]|{token:string}):Promise<Volume[]>;
    image(id:string):Promise<Image|undefined>;
    template(id:string,version:string):Promise<LaunchTemplateVersion|undefined>;
    now():number;
}
/** Mutating SDK calls deliberately do not exist here. Standard owns them. */
export function awsDependencies(settings:Settings,test?:{requestHandler:EC2ClientConfig['requestHandler'];credentials:EC2ClientConfig['credentials'];fetcher:typeof fetch}):Dependencies {
    const opts={region:'us-east-1',maxAttempts:1,...(test?{credentials:test.credentials}:{}),
        requestHandler:test?.requestHandler??{connectionTimeout:2000,requestTimeout:5000,throwOnRequestTimeout:true}};
    const ec2=new EC2Client({...opts,endpoint:'https://ec2.us-east-1.amazonaws.com'});
    const sfn=new SFNClient({...opts,endpoint:'https://states.us-east-1.amazonaws.com'});
    const secrets=new SecretsManagerClient({...opts,endpoint:'https://secretsmanager.us-east-1.amazonaws.com'});
    const request=()=>({abortSignal:AbortSignal.timeout(6000)});
    return {now:Date.now,
        execution:arn=>sfn.send(new DescribeExecutionCommand({executionArn:arn}),request()),
        instances:async selector=>{
            const result=await ec2.send(new DescribeInstancesCommand(Array.isArray(selector)?{InstanceIds:selector}
                :{Filters:[{Name:'client-token',Values:[selector.token]}]}),request());
            const rows=result.Reservations?.flatMap(r=>(r.Instances??[]).map(instance=>({instance,owner:r.OwnerId})))??[];
            if(result.NextToken||rows.length>2)throw new Error('instance_ambiguous');return rows;
        },
        volumes:async selector=>{
            const result=await ec2.send(new DescribeVolumesCommand(Array.isArray(selector)?{VolumeIds:selector}
                :{Filters:[{Name:'tag:ezil:allocation',Values:[selector.token]},{Name:'tag:ezil:stage',Values:[settings.deployment.namespace]}]}),request());
            if(result.NextToken||(result.Volumes?.length??0)>2)throw new Error('volume_ambiguous');return result.Volumes??[];
        },
        image:async id=>{const r=await ec2.send(new DescribeImagesCommand({ImageIds:[id]}),request());if(r.NextToken||r.Images?.length!==1)return undefined;return r.Images[0];},
        template:async(id,version)=>{const r=await ec2.send(new DescribeLaunchTemplateVersionsCommand({LaunchTemplateId:id,Versions:[version]}),request());
            if(r.NextToken||r.LaunchTemplateVersions?.length!==1)return undefined;return r.LaunchTemplateVersions[0];},
        authority:async(i,digest)=>{
            const secret=await secrets.send(new GetSecretValueCommand({SecretId:settings.authoritySecretArn,VersionStage:'AWSCURRENT'}),request());
            if(secret.ARN!==settings.authoritySecretArn||secret.SecretBinary||!secret.SecretString||!secret.VersionStages?.includes('AWSCURRENT')
                ||!/^[a-f0-9]{64}$/.test(secret.SecretString))throw new Error('authority_unavailable');
            const body=canonical(authorityFor(i,digest)),timestamp=String(Math.floor(Date.now()/1000));
            const signature=createHmac('sha256',Buffer.from(secret.SecretString,'hex')).update([
                'ezil-lifecycle-authority-v1','POST',AUTHORITY_PATH,timestamp,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
            const r=await(test?.fetcher??fetch)(settings.authorityOrigin+AUTHORITY_PATH,{method:'POST',redirect:'error',signal:AbortSignal.timeout(6000),
                headers:{'content-type':'application/json','x-ezil-workflow-timestamp':timestamp,'x-ezil-workflow-signature':signature},body});
            const reader=r.body?.getReader();if(!reader)throw new Error('authority_unavailable');
            try {let bytes=0;const parts:Uint8Array[]=[];
                for(;;){const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>4096)throw new Error();parts.push(p.value);}
                if(r.status===403)return false;if(r.status!==200)throw new Error();
                return equal(JSON.parse(Buffer.concat(parts).toString()),{authorized:true,...authorityFor(i,digest)});
            }catch{throw new Error('authority_unavailable')}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
        },
    };
}
export const allocationToken=token;
