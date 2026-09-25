import type { Instance, Volume, Tag, RunInstancesRequest } from '@aws-sdk/client-ec2';
import { z } from 'zod';
import { EnvelopeSchema, SettingsSchema, equal, phases, token, tagsFor, tagList, initialVolumeTags, writerProfile,
    type Phase, type Action, type Settings } from './contract.js';
import type { LifecycleReceipt } from './intent.js';
import { parseComputerLifecycleWork, observeRecoveryWriters, type ComputerLifecycleIntent, type FencedWriters } from './computer-recovery.js';
import { awsDependencies, type Dependencies } from './aws.js';
const eventSchema=z.object({executionArn:z.string().max(300),phase:z.enum(phases)}).strict();
export const tagged=(actual:Tag[]|undefined,expected:Record<string,string>)=>Object.entries(expected).every(([k,v])=>
    actual?.filter(t=>t.Key===k).length===1&&actual.find(t=>t.Key===k)?.Value===v);
const fail=(code='lifecycle_unconfirmed'):never=>{throw new Error(code)};
const wait=(phase:Phase)=>({decision:'wait',phase});
const instanceId=(v:string|undefined):v is string=>/^i-[a-f0-9]{17}$/.test(v??'');
const volumeId=(v:string|undefined):v is string=>/^vol-[a-f0-9]{17}$/.test(v??'');

/** Reconstruct each operation from original Standard input, never caller IDs.
 * Uncertain operations retain their control-plane reservation. No mutations
 * occur in this helper; the fixed Standard graph owns every provider call. */
export function createLifecycleHelper(settings:Settings,deps:Dependencies) {
    const d=settings.deployment,version=d.stateMachineVersionArn,machine=version.slice(0,version.lastIndexOf(':'));
    return async(input:unknown):Promise<Record<string,unknown>>=>{
        const e=eventSchema.safeParse(input);if(!e.success)return fail('lifecycle_invalid');
        const event=e.data;
        if(!event.executionArn.startsWith(machine.replace(':stateMachine:',':execution:')+':computer-'))return fail('lifecycle_invalid');
        const execution=await deps.execution(event.executionArn);
        if(execution.executionArn!==event.executionArn||execution.stateMachineArn!==machine||execution.stateMachineVersionArn!==version
            ||execution.stateMachineAliasArn||execution.redriveCount!==0||execution.status!=='RUNNING'||!execution.input
            ||Buffer.byteLength(execution.input)>20000||!execution.startDate)return fail();
        const envelope=EnvelopeSchema.parse(JSON.parse(execution.input));
        const work={...envelope,createdAt:execution.startDate},i=parseComputerLifecycleWork(work);
        if(envelope.schemaVersion!==i.schemaVersion)return fail('lifecycle_invalid');
        const {instanceProfileArn,...pins}=i.deployment;
        if(!equal(pins,d)||instanceProfileArn!==writerProfile(settings,i)||execution.name!==`computer-${i.jobId}`
            ||event.executionArn!==machine.replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`)return fail('lifecycle_invalid');
        const now=deps.now(),started=execution.startDate.getTime();
        if(!Number.isFinite(started)||started>now+30000||now-started>900000)return fail('lifecycle_expired');
        const authority=async():Promise<FencedWriters|true>=>{
            if(i.schemaVersion===1){if(!await deps.authority(i,envelope.digest))return fail('lifecycle_authority_denied');return true;}
            const result=await deps.recoveryAuthority?.(i,envelope.digest);
            if(!result)return fail('lifecycle_authority_denied');
            return result.writers;
        };
        const approvedWriters=await authority();
        if(i.schemaVersion===2){
            if(approvedWriters===true)return fail('lifecycle_authority_denied');
            await observeRecoveryWriters(i,approvedWriters,started,deps);
        }
        const action=async(name:Action,parameters:object)=>{
            // Reads can consume time. Recheck authority immediately before
            // returning a mutation and leave its 30-second task window intact.
            if(!equal(await authority(),approvedWriters))return fail('lifecycle_authority_denied');
            if(deps.now()-started>870000)return fail('lifecycle_expired');
            return {decision:name,parameters};
        };
        const tags=tagsFor(i),phase=event.phase,newInstance=['provision','replace','recover'].includes(i.operation);
        const volumes=await deps.volumes(i.dataVolumeId?[i.dataVolumeId]:{token:token(envelope.digest,'volume',i.schemaVersion)});
        if(volumes.length>1)return fail('lifecycle_volume_ambiguous');
        const v=volumes[0];
        if(!v){
            if(i.operation!=='provision'||!['initial','volume'].includes(phase))return fail();
            return action('createVolume',{AvailabilityZone:d.availabilityZone,Size:50,VolumeType:'gp3',Iops:3000,Throughput:125,
                Encrypted:true,KmsKeyId:d.dataKeyArn,ClientToken:token(envelope.digest,'volume',i.schemaVersion),
                TagSpecifications:[{ResourceType:'volume',Tags:tagList(initialVolumeTags(i,envelope.digest))}]});
        }
        if(!volumeId(v.VolumeId)||v.VolumeType!=='gp3'||v.Size!==50||v.Encrypted!==true||v.KmsKeyId!==d.dataKeyArn
            ||v.AvailabilityZone!==d.availabilityZone||v.MultiAttachEnabled!==false||!Array.isArray(v.Attachments))return fail('lifecycle_volume_invalid');
        const previousTags=i.schemaVersion===2?tagsFor(i,i.dataScope.generation,i.dataScope.fenceToken)
            :i.operation==='replace'?tagsFor(i,i.previousGeneration!,i.previousFenceToken!):tags;
        if(!tagged(v.Tags,tags)&&!(['replace','recover'].includes(i.operation)&&tagged(v.Tags,previousTags)))return fail('lifecycle_volume_invalid');
        if(i.dataVolumeId&&v.VolumeId!==i.dataVolumeId)return fail();
        if(i.operation==='provision'&&!tagged(v.Tags,initialVolumeTags(i,envelope.digest)))return fail();
        const sourceId=i.schemaVersion===1?i.previousInstanceId??i.providerInstanceId:null;
        const source=sourceId?await getInstance(sourceId,previousTags,i,deps):undefined;
        if(source&&['stop','retire','replace'].includes(i.operation)){
            const status=source.State?.Name;
            if(status==='terminated'){
                if(i.operation==='stop')return fail();
                if(i.operation==='retire'){
                    if(v.State!=='available'||v.Attachments.length)return wait(phase);
                    return success(i,envelope.digest,sourceId!,v.VolumeId,'retired');
                }
                if(v.Attachments.some(a=>a.InstanceId===sourceId))return wait(phase);
            }else{
                if(status==='shutting-down')return wait(phase);
                if(status==='stopped'){
                    if(i.operation==='stop'){
                        assertAttached(source,v,sourceId!);
                        return success(i,envelope.digest,sourceId!,v.VolumeId,'stopped');
                    }
                    if(!['initial','stopped'].includes(phase))return wait(phase);
                    assertAttached(source,v,sourceId!);
                    return action('terminateInstances',{InstanceIds:[sourceId]});
                }
                if(status==='stopping')return wait(phase);
                if(!['running','pending'].includes(status??''))return fail();
                if(phase!=='initial')return wait(phase);
                assertAttached(source,v,sourceId!);
                return action('stopInstances',{InstanceIds:[sourceId],Force:false,Hibernate:false,SkipOsShutdown:false});
            }
        }
        if(v.State==='creating')return wait(phase);
        let target=source;
        if(newInstance){
            const found=await deps.instances({token:token(envelope.digest,'instance',i.schemaVersion)});
            if(found.length>1)return fail('lifecycle_instance_ambiguous');
            target=found[0]?.instance;
            if(target){if(approvedWriters!==true&&approvedWriters.some(w=>w.instanceId===target!.InstanceId))return fail();if(found[0]?.owner!==d.accountId||target.ClientToken!==token(envelope.digest,'instance',i.schemaVersion))return fail();assertIdentity(target,tags,i);}
            if(!target){
                if(v.State!=='available'||v.Attachments.length)return fail();
                return action('runInstances',await launchParameters(i,envelope.digest,deps));
            }
        }
        if(!target||!instanceId(target.InstanceId))return fail();
        assertEffectiveInstance(target,i);
        const targetId=target.InstanceId;
        if(newInstance){
            if(!['pending','running'].includes(target.State?.Name??''))return fail();
            if(!tagged(v.Tags,tags)){
                if(v.State!=='available'||v.Attachments.length)return fail();
                if(phase==='tagged')return wait(phase);
                return action('createTags',{Resources:[v.VolumeId],Tags:tagList(tags)});
            }
            if(v.State==='available'&&v.Attachments.length===0){
                if(phase==='attached'||phase==='preserved')return wait(phase);
                if(target.State?.Name!=='running')return wait(phase);
                return action('attachVolume',{Device:'/dev/sdf',InstanceId:targetId,VolumeId:v.VolumeId});
            }
            if(v.Attachments.length!==1||v.Attachments[0]?.InstanceId!==targetId||v.Attachments[0]?.VolumeId!==v.VolumeId)return fail();
            if(v.Attachments[0]?.State==='attaching'||!target.BlockDeviceMappings?.some(m=>m.Ebs?.VolumeId===v.VolumeId))return wait(phase);
            if(phase!=='preserved')return action('modifyInstanceAttribute',{InstanceId:targetId,
                BlockDeviceMappings:[{DeviceName:'/dev/sdf',Ebs:{VolumeId:v.VolumeId,DeleteOnTermination:false}}]});
            assertAttached(target,v,targetId);
            if(target.State?.Name!=='running')return wait(phase);
            return success(i,envelope.digest,targetId,v.VolumeId,'running');
        }
        assertAttached(target,v,targetId);
        if(i.operation!=='start')return fail();
        if(target.State?.Name==='running')return success(i,envelope.digest,targetId,v.VolumeId,'running');
        if(target.State?.Name==='pending'||target.State?.Name==='stopping'||phase==='started')return wait(phase);
        if(target.State?.Name!=='stopped')return fail();
        return action('startInstances',{InstanceIds:[targetId]});
    };
}
function success(i:ComputerLifecycleIntent,digest:string,instanceId:string,volumeId:string,state:LifecycleReceipt['state']){
    return {decision:'success',receipt:{schemaVersion:i.schemaVersion,jobId:i.jobId,digest,computerId:i.computerId,
        generation:i.targetGeneration,fenceToken:i.fenceToken,instanceId,volumeId,state}};
}
function assertIdentity(instance:Instance,tags:Record<string,string>,i:ComputerLifecycleIntent){
    if(!instanceId(instance.InstanceId)||!tagged(instance.Tags,tags)||instance.Placement?.AvailabilityZone!==i.deployment.availabilityZone)return fail('lifecycle_instance_invalid');
}
async function getInstance(id:string,tags:Record<string,string>,i:ComputerLifecycleIntent,deps:Dependencies){
    const rows=await deps.instances([id]);if(rows.length!==1||rows[0]?.owner!==i.deployment.accountId||rows[0].instance.InstanceId!==id)return fail();
    assertIdentity(rows[0].instance,tags,i);return rows[0].instance;
}
function assertAttached(instance:Instance,v:Volume,id:string){
    const m=instance.BlockDeviceMappings?.filter(m=>m.Ebs?.VolumeId===v.VolumeId),a=v.Attachments?.[0];
    if(v.State!=='in-use'||m?.length!==1||m[0]?.DeviceName!=='/dev/sdf'||m[0]?.Ebs?.Status!=='attached'||m[0]?.Ebs?.DeleteOnTermination!==false
        ||v.Attachments?.length!==1||a?.InstanceId!==id||a.VolumeId!==v.VolumeId||a.State!=='attached'||a.Device!=='/dev/sdf'||a.DeleteOnTermination!==false)return fail('lifecycle_attachment_invalid');
}
function assertEffectiveInstance(v:Instance,i:ComputerLifecycleIntent){
    const d=i.deployment;
    if(v.ImageId!==d.amiId||v.InstanceType!=='m7i.large'||v.Architecture!=='x86_64'||v.RootDeviceType!=='ebs'||v.SubnetId!==d.subnetId
        ||v.IamInstanceProfile?.Arn!==d.instanceProfileArn||v.SecurityGroups?.length!==1||v.SecurityGroups[0]?.GroupId!==d.securityGroupId
        ||v.MetadataOptions?.HttpTokens!=='required'||v.MetadataOptions.HttpPutResponseHopLimit!==1)return fail('lifecycle_instance_invalid');
}
async function launchParameters(i:ComputerLifecycleIntent,digest:string,deps:Dependencies):Promise<RunInstancesRequest>{
    const d=i.deployment;
    const [image,template]=await Promise.all([deps.image(d.amiId),deps.template(d.launchTemplateId,d.launchTemplateVersion)]);
    const t=template?.LaunchTemplateData;
    if(image?.ImageId!==d.amiId||image.Architecture!=='x86_64'||image.RootDeviceType!=='ebs'||image.RootDeviceName!=='/dev/xvda'
        ||image.State!=='available'||image.VirtualizationType!=='hvm'||image.BlockDeviceMappings?.length!==1
        ||image.BlockDeviceMappings[0]?.DeviceName!=='/dev/xvda'||!image.BlockDeviceMappings[0]?.Ebs?.VolumeSize
        ||image.BlockDeviceMappings[0].Ebs.VolumeSize>30||!t||template?.LaunchTemplateId!==d.launchTemplateId
        ||String(template.VersionNumber)!==d.launchTemplateVersion)return fail('lifecycle_launch_invalid');
    const allowed=['ImageId','InstanceType','SecurityGroupIds','IamInstanceProfile','EbsOptimized','Monitoring','MetadataOptions','BlockDeviceMappings','TagSpecifications'];
    if(Object.keys(t).some(k=>!allowed.includes(k))||t.ImageId!==d.amiId||t.InstanceType!=='m7i.large'
        ||!equal(t.SecurityGroupIds,[d.securityGroupId])
        ||t.BlockDeviceMappings?.length!==1||t.BlockDeviceMappings[0]?.DeviceName!=='/dev/xvda')return fail('lifecycle_launch_invalid');
    return {LaunchTemplate:{LaunchTemplateId:d.launchTemplateId,Version:d.launchTemplateVersion},ImageId:d.amiId,
        InstanceType:'m7i.large',MinCount:1,MaxCount:1,ClientToken:token(digest,'instance',i.schemaVersion),
        SubnetId:d.subnetId,SecurityGroupIds:[d.securityGroupId],IamInstanceProfile:{Arn:d.instanceProfileArn},
        Placement:{AvailabilityZone:d.availabilityZone},MetadataOptions:{HttpEndpoint:'enabled',HttpTokens:'required',HttpPutResponseHopLimit:1,InstanceMetadataTags:'enabled'},
        EbsOptimized:true,Monitoring:{Enabled:false},BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeType:'gp3',VolumeSize:30,Encrypted:true,KmsKeyId:d.dataKeyArn,DeleteOnTermination:true}}],
        TagSpecifications:[{ResourceType:'instance',Tags:tagList(tagsFor(i))},{ResourceType:'volume',Tags:tagList({...tagsFor(i),'ezil:disk-kind':'root'})}]};
}
let helper:ReturnType<typeof createLifecycleHelper>|undefined;
export async function handler(input:unknown){
    try {if(!helper){const settings=SettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_SETTINGS??''));helper=createLifecycleHelper(settings,awsDependencies(settings));}
        return await helper(input);
    }catch{return fail('lifecycle_unconfirmed')}
}
