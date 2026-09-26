import { createHash, createHmac } from 'node:crypto';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, type EC2ClientConfig,
    type DescribeInstancesResult, type DescribeVolumesResult } from '@aws-sdk/client-ec2';
import { SSMClient, ListCommandsCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { canonical, equal, type StartInput, type Settings } from './contract.js';

export const AUTHORITY_PATH = '/api/internal/computers/start-authority';
export function signature(body: string, key: string, timestamp: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[0-9]{10}$/.test(timestamp)) throw new Error('start_authority_unavailable');
    return createHmac('sha256',Buffer.from(key,'hex')).update(['ezil-start-authority-v1','POST',AUTHORITY_PATH,
        timestamp,createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
}
export interface Dependencies {
    execution(arn:string):Promise<import('@aws-sdk/client-sfn').DescribeExecutionOutput>;
    authority(input:StartInput):Promise<boolean>;
    writer(input:StartInput):Promise<boolean>;
    command(id:string):Promise<import('@aws-sdk/client-ssm').Command|undefined>;
    invocation(id:string,instance:string):Promise<import('@aws-sdk/client-ssm').GetCommandInvocationResult|undefined>;
    now():number;
}
/** Read APIs only. Standard owns SendCommand, with no billable/mutating retry. */
export function awsDependencies(s:Settings,test?:{requestHandler:EC2ClientConfig['requestHandler'];credentials:EC2ClientConfig['credentials'];fetcher:typeof fetch}):Dependencies {
    const opts={region:'us-east-1',maxAttempts:1,...(test?{credentials:test.credentials}:{}),
        requestHandler:test?.requestHandler??{connectionTimeout:2000,requestTimeout:5000,throwOnRequestTimeout:true}};
    const ec2=new EC2Client({...opts,endpoint:'https://ec2.us-east-1.amazonaws.com'});
    const ssm=new SSMClient({...opts,endpoint:'https://ssm.us-east-1.amazonaws.com'});
    const sfn=new SFNClient({...opts,endpoint:'https://states.us-east-1.amazonaws.com'});
    const secrets=new SecretsManagerClient({...opts,endpoint:'https://secretsmanager.us-east-1.amazonaws.com'});
    const request=()=>({abortSignal:AbortSignal.timeout(6000)});
    return {now:Date.now,execution:arn=>sfn.send(new DescribeExecutionCommand({executionArn:arn}),request()),
        command:async id=>{
            const r=await ssm.send(new ListCommandsCommand({CommandId:id,MaxResults:1}),request());
            if(r.NextToken||(r.Commands?.length??0)>1)throw new Error('start_command_ambiguous');return r.Commands?.[0];
        },
        invocation:async(id,instance)=>{
            try{return await ssm.send(new GetCommandInvocationCommand({CommandId:id,InstanceId:instance,PluginName:'operateStart'}),request());}
            catch(e){if(e instanceof Error&&e.name==='InvocationDoesNotExist')return undefined;throw e;}
        },
        writer:async i=>{
            const scope=i.work.scope;
            const [instances,volumes]=await Promise.all([
                ec2.send(new DescribeInstancesCommand({InstanceIds:[scope.providerInstanceId]}),request()),
                ec2.send(new DescribeVolumesCommand({VolumeIds:[scope.dataVolumeId]}),request())]);
            return validWriter(i,instances,volumes);
        },
        authority:async i=>{
            const v=await secrets.send(new GetSecretValueCommand({SecretId:s.authoritySecretArn,VersionStage:'AWSCURRENT'}),request());
            if(v.ARN!==s.authoritySecretArn||v.SecretBinary||!v.SecretString||!v.VersionStages?.includes('AWSCURRENT'))throw new Error('start_authority_unavailable');
            return requestAuthority(s.authorityOrigin,v.SecretString,i,test?.fetcher);
        },
    };
}
export async function requestAuthority(origin:string,key:string,i:StartInput,fetcher:typeof fetch=fetch) {
    const body=canonical(i.work),timestamp=String(Math.floor(Date.now()/1000)),controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    try {
        const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error());},6000);});
        return await Promise.race([timeout,(async()=>{
            const r=await fetcher(origin+AUTHORITY_PATH,{method:'POST',redirect:'error',signal:controller.signal,
                headers:{'content-type':'application/json','x-ezil-workflow-timestamp':timestamp,
                    'x-ezil-workflow-signature':signature(body,key,timestamp)},body});
            if(controller.signal.aborted){void r.body?.cancel().catch(()=>{});throw new Error();}
            reader=r.body?.getReader();if(!reader)throw new Error();
            let size=0;const chunks:Uint8Array[]=[];
            for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>16384)throw new Error();chunks.push(p.value);}
            if(r.status===403)return false;
            if(r.status!==200||!/^application\/json(?:;|$)/i.test(r.headers.get('content-type')??''))throw new Error();
            return equal(JSON.parse(Buffer.concat(chunks).toString()),{authorized:true,work:i.work});
        })()]);
    }catch{throw new Error('start_authority_unavailable');}
    finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});reader?.releaseLock();}
}
/** Provider truth, independent of the DB callback. A stopped/replaced/unknown
 * writer cannot receive even a cancellation command through this operation. */
export function validWriter(input:StartInput,instances:DescribeInstancesResult,volumes:DescribeVolumesResult) {
    const scope=input.work.scope,d=input.work.deployment;
    const rows=instances.Reservations?.flatMap(r=>(r.Instances??[]).map(instance=>({instance,owner:r.OwnerId})))??[];
    if(instances.NextToken||volumes.NextToken||rows.length!==1||volumes.Volumes?.length!==1)return false;
    const {instance:i,owner}=rows[0]!,v=volumes.Volumes[0]!;
    const tags={'ezil:managed-by':'app-computer-platform','ezil:stage':d.namespace,'ezil:computer-id':scope.computerId,
        'ezil:generation':String(scope.computerGeneration),'ezil:fence-token':scope.fenceToken};
    const tagged=(list:typeof i.Tags)=>Object.entries(tags).every(([k,value])=>list?.filter(t=>t.Key===k).length===1&&list.find(t=>t.Key===k)?.Value===value);
    const mappings=i.BlockDeviceMappings?.filter(m=>m.Ebs?.VolumeId===scope.dataVolumeId),mapping=mappings?.[0],attachment=v.Attachments?.[0];
    return owner===d.accountId&&i.InstanceId===scope.providerInstanceId&&i.State?.Name==='running'&&tagged(i.Tags)&&tagged(v.Tags)
        &&i.Architecture==='x86_64'&&i.InstanceType==='m7i.large'&&i.ImageId===d.amiId&&i.SubnetId===d.subnetId
        &&i.SecurityGroups?.length===1&&i.SecurityGroups[0]?.GroupId===d.securityGroupId&&i.IamInstanceProfile?.Arn===d.instanceProfileArn
        &&i.MetadataOptions?.HttpTokens==='required'&&i.MetadataOptions.HttpPutResponseHopLimit===1
        &&i.Placement?.AvailabilityZone===d.availabilityZone&&v.AvailabilityZone===d.availabilityZone
        &&v.VolumeId===scope.dataVolumeId&&v.State==='in-use'&&v.Encrypted===true&&v.KmsKeyId===d.dataKeyArn
        &&v.VolumeType==='gp3'&&v.Size===50&&v.MultiAttachEnabled===false&&v.Attachments?.length===1
        &&attachment?.InstanceId===i.InstanceId&&attachment.State==='attached'&&mappings?.length===1
        &&mapping?.Ebs?.DeleteOnTermination===false&&mapping.Ebs.Status==='attached'&&mapping.DeviceName==='/dev/sdf'
        &&attachment.Device===mapping.DeviceName;
}
