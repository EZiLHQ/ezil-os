import { createHash, randomUUID } from 'node:crypto';
import type { Instance, Volume } from '@aws-sdk/client-ec2';
import type { Dependencies } from '../lib/lifecycle/aws.js';
import { SettingsSchema, tagsFor, tagList, token, initialVolumeTags, poolTagsFor, claimTagsFor } from '../lib/lifecycle/contract.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
import { DEFAULT_STORAGE, type InstanceType, type Storage } from '../lib/lifecycle/deployment.js';
export const REGION='ap-south-1',ZONE_ID='aps1-az1';
export function lifecycleFixture(operation:LifecycleIntent['operation']='provision',options:{instanceType?:InstanceType;instanceTypes?:InstanceType[];dataVolumeGiB?:number;rootDeviceName?:Storage['rootDeviceName'];userData?:string|null;userDataNonce?:boolean}={}){
    const computerId=randomUUID(),generation=['replace','adopt','release'].includes(operation)?2:1;
    const deployment={accountId:'123456789012',region:REGION,zoneId:ZONE_ID,
        subnetId:'subnet-11111111111111111',securityGroupId:'sg-11111111111111111',launchTemplateId:'lt-11111111111111111',launchTemplateVersion:'1',
        amiId:'ami-11111111111111111',namespace:'pilot',instanceTypes:options.instanceTypes??['m6i.large','c6i.xlarge','m6i.xlarge','m6i.2xlarge'] as InstanceType[],
        storage:{...DEFAULT_STORAGE,rootDeviceName:options.rootDeviceName??DEFAULT_STORAGE.rootDeviceName},
        dataKeyArn:`arn:aws:kms:${REGION}:123456789012:key/11111111-1111-4111-8111-111111111111`,
        stateMachineVersionArn:`arn:aws:states:${REGION}:123456789012:stateMachine:ezil-pilot-lifecycle:1`};
    const settings=SettingsSchema.parse({deployment,features:{userDataNonce:options.userDataNonce??false},authorityOrigin:'https://control.example',
        authoritySecretArn:`arn:aws:secretsmanager:${REGION}:123456789012:secret:ezil/pilot/lifecycle-key-abcdef`});
    const instanceType=options.instanceType??'m6i.large',dataVolumeGiB=operation==='provision'?options.dataVolumeGiB??20:operation==='adopt'?options.dataVolumeGiB??null:null;
    const i:LifecycleIntent={schemaVersion:1,jobId:randomUUID(),computerId,revision:1,operation,targetGeneration:generation,fenceToken:randomUUID(),
        providerInstanceId:['provision','replace','pool-provision'].includes(operation)?null:'i-11111111111111111',
        dataVolumeId:['provision','pool-provision'].includes(operation)||(operation==='adopt'&&dataVolumeGiB!==null)?null:'vol-11111111111111111',
        ...(operation==='pool-provision'?{poolHostId:computerId,poolGeneration:generation}:operation==='adopt'?{poolHostId:randomUUID()}:{}),
        previousGeneration:operation==='replace'?1:null,previousInstanceId:operation==='replace'?'i-22222222222222222':null,
        previousFenceToken:operation==='replace'?randomUUID():null,
        deployment,instanceType,dataVolumeGiB,leaseEpoch:operation==='provision'?1:3,
        userData:options.userData!==undefined?options.userData:['provision','replace'].includes(operation)?'ZXppbC1ub25jZQ==':null};
    const document=JSON.stringify(i),digest=createHash('sha256').update(document).digest('hex');
    const envelope={schemaVersion:1,document,digest};const machine=deployment.stateMachineVersionArn.slice(0,-2);
    const executionArn=machine.replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`;
    const state={now:Date.now(),authorized:true,authorityCalls:0,
        execution:{executionArn,stateMachineArn:machine,stateMachineVersionArn:deployment.stateMachineVersionArn,redriveCount:0,
            name:`computer-${i.jobId}`,status:'RUNNING' as const,startDate:new Date(),input:JSON.stringify(envelope)},
        instances:[] as Instance[],volumes:[] as Volume[],imageBad:false,templateBad:false};
    function instance(id:string,g=i.targetGeneration,fence=i.fenceToken):Instance{return {
        InstanceId:id,ClientToken:token(digest,'instance'),Tags:tagList(tagsFor(i,g,fence)),Placement:{AvailabilityZoneId:deployment.zoneId},
        ImageId:deployment.amiId,InstanceType:instanceType,Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:deployment.storage.rootDeviceName,SubnetId:deployment.subnetId,
        SecurityGroups:[{GroupId:deployment.securityGroupId}],State:{Name:'running'},HibernationOptions:{Configured:false},
        MetadataOptions:{HttpTokens:'required',HttpPutResponseHopLimit:1,InstanceMetadataTags:'disabled',State:'applied'},
        BlockDeviceMappings:[{DeviceName:deployment.storage.rootDeviceName,Ebs:{VolumeId:'vol-00000000000000000',Status:'attached',DeleteOnTermination:true}}]};}
    function volume():Volume{return {VolumeId:'vol-11111111111111111',State:'available',AvailabilityZoneId:deployment.zoneId,VolumeType:'gp3',Size:dataVolumeGiB??50,
        Encrypted:true,KmsKeyId:deployment.dataKeyArn,MultiAttachEnabled:false,Attachments:[],Tags:tagList(initialVolumeTags(i,digest))};}
    function attach(v:Volume,target:Instance){v.State='in-use';v.Attachments=[{InstanceId:target.InstanceId,VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
        target.BlockDeviceMappings=[...(target.BlockDeviceMappings??[]).filter(m=>m.Ebs?.VolumeId!==v.VolumeId),{DeviceName:'/dev/sdf',Ebs:{VolumeId:v.VolumeId,Status:'attached',DeleteOnTermination:false}}];}
    if(!['provision','pool-provision'].includes(operation)){
        const old=instance(i.previousInstanceId??i.providerInstanceId!,i.previousGeneration??i.targetGeneration,i.previousFenceToken??i.fenceToken);
        old.ClientToken='historical-token';if(operation==='start')old.State={Name:'stopped'};
        const v=volume();v.Tags=old.Tags;
        if(operation==='adopt'){
            old.Tags=tagList(poolTagsFor(i));v.Tags=tagList(tagsFor(i,1,randomUUID()));
        }else{
            attach(v,old);
            if(operation==='release'){
                old.Tags=tagList({'ezil:managed-by':'app-computer-platform','ezil:stage':deployment.namespace,'ezil:namespace':deployment.namespace,...claimTagsFor(i)});
                v.Tags=tagList({...tagsFor(i),...claimTagsFor(i)});
            }
        }
        state.instances.push(old);if(i.dataVolumeId!==null)state.volumes.push(v);
    }
    const deps:Dependencies={now:()=>state.now,execution:async()=>structuredClone(state.execution),authority:async()=>{state.authorityCalls++;return state.authorized;},
        instances:async selector=>structuredClone(state.instances.filter(v=>Array.isArray(selector)?selector.includes(v.InstanceId!):v.ClientToken===selector.token)
            .map(instance=>({instance,owner:deployment.accountId}))),
        volumes:async selector=>structuredClone(state.volumes.filter(v=>Array.isArray(selector)?selector.includes(v.VolumeId!):v.Tags?.some(t=>t.Key==='ezil:allocation'&&t.Value===selector.token))),
        image:async()=>({ImageId:deployment.amiId,Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:state.imageBad?'/other':deployment.storage.rootDeviceName,State:'available',VirtualizationType:'hvm',BlockDeviceMappings:[{DeviceName:deployment.storage.rootDeviceName,Ebs:{VolumeSize:30}}]}),
        template:async()=>({LaunchTemplateId:deployment.launchTemplateId,VersionNumber:1,LaunchTemplateData:{ImageId:deployment.amiId,InstanceType:'m6i.large',
            SecurityGroupIds:[deployment.securityGroupId],BlockDeviceMappings:[{DeviceName:deployment.storage.rootDeviceName}],...(state.templateBad?{UserData:'unapproved'}:{})}})};
    return {i,settings,envelope,digest,executionArn,state,deps,instance,volume,attach};
}
