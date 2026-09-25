import { createHash, randomUUID } from 'node:crypto';
import type { Instance, Volume } from '@aws-sdk/client-ec2';
import type { Dependencies } from '../lib/lifecycle/aws.js';
import { SettingsSchema, tagsFor, tagList, token, initialVolumeTags } from '../lib/lifecycle/contract.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
export function lifecycleFixture(operation:LifecycleIntent['operation']='provision'){
    const computerId=randomUUID(),generation=operation==='replace'?2:1;
    const deployment={accountId:'123456789012',region:'us-east-1' as const,availabilityZone:'us-east-1a',
        subnetId:'subnet-11111111111111111',securityGroupId:'sg-11111111111111111',launchTemplateId:'lt-11111111111111111',launchTemplateVersion:'1',
        amiId:'ami-11111111111111111',namespace:'pilot',
        dataKeyArn:'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
        stateMachineVersionArn:'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle:1'};
    const settings=SettingsSchema.parse({deployment,writerRolePathPrefix:'ezil/pilot/computers',authorityOrigin:'https://control.example',
        authoritySecretArn:'arn:aws:secretsmanager:us-east-1:123456789012:secret:ezil/lifecycle-key-abcdef'});
    const i:LifecycleIntent={schemaVersion:1,jobId:randomUUID(),computerId,revision:1,operation,targetGeneration:generation,fenceToken:randomUUID(),
        providerInstanceId:['provision','replace'].includes(operation)?null:'i-11111111111111111',dataVolumeId:operation==='provision'?null:'vol-11111111111111111',
        previousGeneration:operation==='replace'?1:null,previousInstanceId:operation==='replace'?'i-22222222222222222':null,
        previousFenceToken:operation==='replace'?randomUUID():null,
        deployment:{...deployment,instanceProfileArn:`arn:aws:iam::123456789012:instance-profile/ezil/pilot/computers/${computerId}/g${generation}`}};
    const document=JSON.stringify(i),digest=createHash('sha256').update(document).digest('hex');
    const envelope={schemaVersion:1,document,digest};const machine=deployment.stateMachineVersionArn.slice(0,-2);
    const executionArn=machine.replace(':stateMachine:',':execution:')+`:computer-${i.jobId}`;
    const state={now:Date.now(),authorized:true,authorityCalls:0,
        execution:{executionArn,stateMachineArn:machine,stateMachineVersionArn:deployment.stateMachineVersionArn,redriveCount:0,
            name:`computer-${i.jobId}`,status:'RUNNING' as const,startDate:new Date(),input:JSON.stringify(envelope)},
        instances:[] as Instance[],volumes:[] as Volume[],imageBad:false,templateBad:false};
    function instance(id:string,g=i.targetGeneration,fence=i.fenceToken):Instance{return {
        InstanceId:id,ClientToken:token(digest,'instance'),Tags:tagList(tagsFor(i,g,fence)),Placement:{AvailabilityZone:deployment.availabilityZone},
        ImageId:deployment.amiId,InstanceType:'m7i.large',Architecture:'x86_64',RootDeviceType:'ebs',SubnetId:deployment.subnetId,
        IamInstanceProfile:{Arn:i.deployment.instanceProfileArn},SecurityGroups:[{GroupId:deployment.securityGroupId}],State:{Name:'running'},
        MetadataOptions:{HttpTokens:'required',HttpPutResponseHopLimit:1,State:'applied'},BlockDeviceMappings:[]};}
    function volume():Volume{return {VolumeId:'vol-11111111111111111',State:'available',AvailabilityZone:deployment.availabilityZone,VolumeType:'gp3',Size:50,
        Encrypted:true,KmsKeyId:deployment.dataKeyArn,MultiAttachEnabled:false,Attachments:[],Tags:tagList(initialVolumeTags(i,digest))};}
    function attach(v:Volume,target:Instance){v.State='in-use';v.Attachments=[{InstanceId:target.InstanceId,VolumeId:v.VolumeId,State:'attached',Device:'/dev/sdf',DeleteOnTermination:false}];
        target.BlockDeviceMappings=[{DeviceName:'/dev/sdf',Ebs:{VolumeId:v.VolumeId,Status:'attached',DeleteOnTermination:false}}];}
    if(operation!=='provision'){
        const old=instance(i.previousInstanceId??i.providerInstanceId!,i.previousGeneration??i.targetGeneration,i.previousFenceToken??i.fenceToken);
        old.ClientToken='historical-token';if(operation==='start')old.State={Name:'stopped'};
        const v=volume();v.Tags=old.Tags;attach(v,old);state.instances.push(old);state.volumes.push(v);
    }
    const deps:Dependencies={now:()=>state.now,execution:async()=>structuredClone(state.execution),authority:async()=>{state.authorityCalls++;return state.authorized;},
        instances:async selector=>structuredClone(state.instances.filter(v=>Array.isArray(selector)?selector.includes(v.InstanceId!):v.ClientToken===selector.token)
            .map(instance=>({instance,owner:deployment.accountId}))),
        volumes:async selector=>structuredClone(state.volumes.filter(v=>Array.isArray(selector)?selector.includes(v.VolumeId!):v.Tags?.some(t=>t.Key==='ezil:allocation'&&t.Value===selector.token))),
        image:async()=>({ImageId:deployment.amiId,Architecture:'x86_64',RootDeviceType:'ebs',RootDeviceName:state.imageBad?'/other':'/dev/xvda',State:'available',VirtualizationType:'hvm',BlockDeviceMappings:[{DeviceName:'/dev/xvda',Ebs:{VolumeSize:8}}]}),
        template:async()=>({LaunchTemplateId:deployment.launchTemplateId,VersionNumber:1,LaunchTemplateData:{ImageId:deployment.amiId,InstanceType:'m7i.large',
            SecurityGroupIds:[deployment.securityGroupId],BlockDeviceMappings:[{DeviceName:'/dev/xvda'}],...(state.templateBad?{UserData:'unapproved'}:{})}})};
    return {i,settings,envelope,digest,executionArn,state,deps,instance,volume,attach};
}
