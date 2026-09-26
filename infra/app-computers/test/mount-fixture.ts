import { createHash } from 'node:crypto';
import { canonical, type Settings, type MountInput } from '../lib/mount/contract.js';
import type { Dependencies } from '../lib/mount/aws.js';
import type { HelperEvent } from '../lib/mount/helper.js';
export const settings:Settings={deployment:{accountId:'123456789012',region:'us-east-1',availabilityZone:'us-east-1a',
    subnetId:'subnet-11111111111111111',securityGroupId:'sg-11111111111111111',launchTemplateId:'lt-11111111111111111',launchTemplateVersion:'1',
    amiId:'ami-11111111111111111',namespace:'pilot',dataKeyArn:'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    stateMachineVersionArn:'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle:1'},writerRolePathPrefix:'ezil/pilot/computers',
    bucket:'ezil-test-configurations',machineArn:'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-mount-pilot',workflowVersion:'1',
    authorityOrigin:'https://cloud.ezil.org',authoritySecretArn:'arn:aws:secretsmanager:us-east-1:123456789012:secret:ezil/mount-abcdef',
    documentName:'ezil-mount-pilot-test',documentVersion:'1',documentHash:'a'.repeat(64)};
export function fixture() {
    const issuedAt=Math.floor(Date.now()/1000)-5,start=issuedAt*1000+1000;
    const scope={computerId:'22222222-2222-4222-8222-222222222222',computerGeneration:1,fenceToken:'33333333-3333-4333-8333-333333333333',
        providerInstanceId:'i-12345678901234567',dataVolumeId:'vol-12345678901234567'};
    const plan={schemaVersion:1 as const,computerId:scope.computerId,filesystemUuid:'44444444-4444-4444-8444-444444444444',mode:'initialize' as const,volumeId:scope.dataVolumeId};
    const digest=createHash('sha256').update(canonical(plan)).digest('hex');
    const input:MountInput={schemaVersion:1,work:{plan,authorization:{schemaVersion:1,authorizationId:'11111111-1111-4111-8111-111111111111',
        scope,filesystemUuid:plan.filesystemUuid,mode:plan.mode,digest,issuedAt,expiresAt:issuedAt+900},deployment:{...settings.deployment,
        instanceProfileArn:`arn:aws:iam::123456789012:instance-profile/ezil/pilot/computers/${scope.computerId}/g1`}},object:{bucket:settings.bucket,
        key:`pilot/computers/${scope.computerId}/generations/1/data-mounts/11111111-1111-4111-8111-111111111111.json`,versionId:'immutable-version',sha256:digest,bytes:Buffer.byteLength(canonical(plan))}};
    const state={now:start+1000,authorized:true,writer:true,authorityCalls:0,execution:{
        executionArn:settings.machineArn.replace(':stateMachine:',':execution:')+':mount-'+input.work.authorization.authorizationId,
        stateMachineArn:settings.machineArn,stateMachineVersionArn:settings.machineArn+':1',name:'mount-'+input.work.authorization.authorizationId,
        status:'RUNNING' as const,redriveCount:0,startDate:new Date(start),input:canonical(input),$metadata:{}}};
    const deps:Dependencies={now:()=>state.now,authority:async()=>{state.authorityCalls++;return state.authorized;},writer:async()=>state.writer,
        execution:async()=>state.execution,command:async()=>undefined,invocation:async()=>undefined};
    const event:HelperEvent={mode:'initialize',executionArn:state.execution.executionArn,recovery:false,recoveryStartedAt:new Date(start).toISOString()};
    return {input,state,deps,event,start};
}
export function providerFixture(input:MountInput) {
    const d=input.work.deployment,s=input.work.authorization.scope;
    const tags=Object.entries({'ezil:managed-by':'app-computer-platform','ezil:stage':d.namespace,'ezil:computer-id':s.computerId,
        'ezil:generation':String(s.computerGeneration),'ezil:fence-token':s.fenceToken}).map(([Key,Value])=>({Key,Value}));
    const instance={InstanceId:s.providerInstanceId,State:{Name:'running' as const},Tags:tags,Architecture:'x86_64' as const,InstanceType:'m7i.large' as const,
        ImageId:d.amiId,SubnetId:d.subnetId,SecurityGroups:[{GroupId:d.securityGroupId}],IamInstanceProfile:{Arn:d.instanceProfileArn},
        MetadataOptions:{HttpTokens:'required' as const,HttpPutResponseHopLimit:1},Placement:{AvailabilityZone:d.availabilityZone},
        BlockDeviceMappings:[{DeviceName:'/dev/sdf',Ebs:{VolumeId:s.dataVolumeId,DeleteOnTermination:false,Status:'attached' as const}}]};
    const volume={VolumeId:s.dataVolumeId,State:'in-use' as const,Encrypted:true,KmsKeyId:d.dataKeyArn,VolumeType:'gp3' as const,Size:50,
        MultiAttachEnabled:false,AvailabilityZone:d.availabilityZone,Tags:tags,Attachments:[{InstanceId:s.providerInstanceId,State:'attached' as const,Device:'/dev/sdf'}]};
    return {instances:{Reservations:[{OwnerId:d.accountId,Instances:[instance]}]},volumes:{Volumes:[volume]},instance,volume};
}
