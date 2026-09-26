import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, parseInput, hostOperation, hostObservation, receiptFor, SettingsSchema } from '../lib/mount/contract.js';
import { signature, requestAuthority, validWriter } from '../lib/mount/aws.js';
import { createMountHelper } from '../lib/mount/helper.js';
import { mountDefinition } from '../lib/mount/definition.js';
import { fixture, providerFixture, settings } from './mount-fixture.js';

test('strict work binds deployment, per-writer IAM, immutable object and 900-second grant',()=>{
    const {input:i}=fixture();assert.deepEqual(SettingsSchema.parse(settings),settings);assert.deepEqual(parseInput(i,settings),i);
    const changes=[{...i,extra:'private'}, {...i,object:{...i.object,versionId:'null'}}, {...i,object:{...i.object,key:'../other'}},
        {...i,object:{...i.object,bytes:1}}, {...i,object:{...i.object,sha256:'0'.repeat(64)}},
        {...i,work:{...i.work,deployment:{...i.work.deployment,instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/admin'}}},
        {...i,work:{...i.work,authorization:{...i.work.authorization,expiresAt:i.work.authorization.expiresAt+1}}},
        {...i,work:{...i.work,plan:{...i.work.plan,mode:'mount'}}}];
    for(const c of changes)assert.throws(()=>parseInput(c,settings),/^Error: mount_input_invalid$/);
});
test('host envelope carries exact independent records without extending the grant',()=>{
    const {input:i}=fixture();
    for(const action of ['start','observe','cancel'] as const){
        const v=JSON.parse(Buffer.from(hostOperation(i,settings,action),'base64').toString());
        assert.deepEqual(Object.keys(v).sort(),['action','records','schemaVersion']);assert.equal(v.action,action);
        assert.deepEqual(v.records.authorization,i.work.authorization);assert.deepEqual(v.records.delivery.object,i.object);
        assert.equal(v.records.provisioning.kmsKeyArn,i.work.deployment.dataKeyArn);
    }
});
test('only exact scoped mounted receipts survive host output parsing',()=>{
    const {input:i}=fixture(),a=i.work.authorization;
    const v={schemaVersion:1,authorizationId:a.authorizationId,scope:a.scope,status:'succeeded',result:receiptFor(i)};
    assert.equal(hostObservation(canonical(v),i),'succeeded');
    for(const invalid of [{...v,status:'running'},{...v,result:undefined},{...v,result:{...v.result,filesystemUuid:a.scope.computerId}},
        {...v,scope:{...a.scope,computerGeneration:2}},{...v,secret:'private'}])assert.throws(()=>hostObservation(canonical(invalid),i));
});
test('current-authority protocol matches the distinct HTTP realm and exact work',async()=>{
    const {input:i}=fixture(),key='1'.repeat(64);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async(url,init)=>{
        assert.equal(url,'https://cloud.ezil.org/api/internal/computers/mount-authority');assert.equal(init?.redirect,'error');
        const h=new Headers(init?.headers);assert.equal(h.has('authorization'),false);assert.deepEqual(JSON.parse(String(init?.body)),i.work);
        assert.equal(h.get('x-ezil-workflow-signature'),signature(String(init?.body),key,h.get('x-ezil-workflow-timestamp')!));
        return Response.json({authorized:true,work:i.work});
    }),true);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async()=>Response.json({code:'revoked'},{status:403})),false);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async()=>Response.json({authorized:true})),false);
    for(const response of [new Response('secret',{status:302}),new Response('x'.repeat(16385)),new Response('private',{status:500})])
        await assert.rejects(requestAuthority(settings.authorityOrigin,key,i,async()=>response),/^Error: mount_authority_unavailable$/);
});
test('AWS writer evidence binds owner, tags, approved image/network/IAM and preserved encrypted attachment',()=>{
    const {input:i}=fixture(),p=providerFixture(i);assert.equal(validWriter(i,p.instances,p.volumes),true);
    for(const change of [{ImageId:'ami-00000000000000000'},{SubnetId:'subnet-00000000000000000'},{SecurityGroups:[]},{IamInstanceProfile:{Arn:'admin'}},
        {Tags:[...p.instance.Tags,p.instance.Tags[0]!]},{State:{Name:'stopped' as const}},{MetadataOptions:{HttpTokens:'optional' as const}}])
        assert.equal(validWriter(i,{Reservations:[{OwnerId:'123456789012',Instances:[{...p.instance,...change}]}]},p.volumes),false);
    for(const change of [{Encrypted:false},{MultiAttachEnabled:true},{Attachments:[...p.volume.Attachments,...p.volume.Attachments]},
        {KmsKeyId:'other'},{AvailabilityZone:'us-east-1b'},{Size:51},{Tags:[]}])assert.equal(validWriter(i,p.instances,{Volumes:[{...p.volume,...change}]}),false);
    const unsafe=structuredClone(p.instances);unsafe.Reservations[0]!.Instances[0]!.BlockDeviceMappings[0]!.Ebs.DeleteOnTermination=true;
    assert.equal(validWriter(i,unsafe,p.volumes),false);assert.equal(validWriter(i,{NextToken:'more',...p.instances},p.volumes),false);
});
test('start requires fresh DB and provider authority; expired or revoked work cancels',async()=>{
    for(const condition of ['approved','revoked','expired','provider','unavailable','slow']){
        const f=fixture();if(condition==='revoked')f.state.authorized=false;
        if(condition==='expired')f.state.now=f.input.work.authorization.expiresAt*1000;
        if(condition==='provider')f.state.writer=false;
        if(condition==='unavailable')f.deps.authority=async()=>{throw new Error('private');};
        if(condition==='slow')f.deps.authority=async()=>{f.state.now=f.input.work.authorization.expiresAt*1000;return true;};
        const r=await createMountHelper(settings,f.deps)(f.event);
        if(condition==='provider')assert.deepEqual(r,{decision:'unconfirmed'});
        else {assert.equal(r.decision,'dispatch');if(r.decision!=='dispatch')throw new Error();assert.equal(r.attempt.action,condition==='approved'?'start':'cancel');}
    }
});
test('a stalled authority body has a hard deadline and is cancelled',async()=>{
    let cancelled=false;const start=Date.now();
    const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
    await assert.rejects(requestAuthority(settings.authorityOrigin,'1'.repeat(64),fixture().input,
        async()=>new Response(body,{headers:{'content-type':'application/json'}})),/^Error: mount_authority_unavailable$/);
    assert.equal(cancelled,true);assert.ok(Date.now()-start<10000);
});
test('lost command responses only observe the same operation; expiry causes cancellation',async()=>{
    const f=fixture(),helper=createMountHelper(settings,f.deps),first=await helper(f.event);if(first.decision!=='dispatch')throw new Error();
    f.state.now+=5000;let r=await helper({...f.event,mode:'lost',attempt:first.attempt});assert.equal(r.decision==='dispatch'&&r.attempt.action,'observe');
    f.state.now=f.input.work.authorization.expiresAt*1000;r=await helper({...f.event,mode:'lost',attempt:first.attempt});
    assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
});
test('revoked historical cleanup cannot start work or report a mounted success',async()=>{
    const f=fixture();Object.assign(f.state.execution,{status:'ABORTED'});f.deps.authority=async()=>{throw new Error('must not call');};
    const r=await createMountHelper(settings,f.deps)({...f.event,recovery:true});assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
});
test('forged executions, aliases, redrives and changed immutable input fail redacted',async()=>{
    for(const change of [{stateMachineVersionArn:settings.machineArn+':2'},{redriveCount:1},{stateMachineAliasArn:'alias'},
        {name:'other'},{input:'private'},{startDate:new Date(0)}]){
        const f=fixture();Object.assign(f.state.execution,change);
        await assert.rejects(createMountHelper(settings,f.deps)(f.event),/^Error: mount_workflow_unavailable$/);
    }
});
async function polling(status='succeeded'){
    const f=fixture(),helper=createMountHelper(settings,f.deps),r=await helper(f.event);if(r.decision!=='dispatch')throw new Error();
    const id='55555555-5555-4555-8555-555555555555';f.state.now+=5000;
    const command={...r.parameters,CommandId:id,RequestedDateTime:new Date(r.attempt.issuedAt)};
    const invocation={CommandId:id,InstanceId:f.input.work.authorization.scope.providerInstanceId,DocumentName:settings.documentName,
        DocumentVersion:settings.documentVersion,PluginName:'operateMount',Status:'Success' as const,ResponseCode:0,StandardOutputContent:canonical({
            schemaVersion:1,authorizationId:f.input.work.authorization.authorizationId,scope:f.input.work.authorization.scope,status,
            ...(status==='succeeded'?{result:receiptFor(f.input)}:{})})};
    f.deps.command=async()=>command;f.deps.invocation=async()=>invocation;
    const event={...f.event,mode:'poll',attempt:r.attempt,commandId:id};return {...f,helper,event,command,invocation};
}
test('bound SSM output returns the raw receipt and rechecks both authorities',async()=>{
    const f=await polling();assert.deepEqual(await f.helper(f.event),{decision:'success',result:receiptFor(f.input)});
    assert.equal(f.state.authorityCalls,3);
});
test('SSM command completion alone never becomes a mount receipt',async()=>{
    for(const status of ['absent','unknown','running','failed','cancelling','cancelled']){
        const f=await polling(status),r=await f.helper(f.event);
        if(status==='cancelled')assert.deepEqual(r,{decision:'cancelled'});
        else assert.equal(r.decision==='dispatch'&&r.attempt.action,['failed','cancelling'].includes(status)?'cancel':'observe');
    }
    const f=await polling();f.invocation.StandardOutputContent='{}';await assert.rejects(f.helper(f.event),/^Error: mount_workflow_unavailable$/);
});
test('forged SSM targets and plugin outcomes are not accepted',async()=>{
    const f=await polling();f.command.InstanceIds=['i-00000000000000000'];await assert.rejects(f.helper(f.event));
    const g=await polling();g.invocation.PluginName='operateConfiguration';await assert.rejects(g.helper(g.event));
});
test('revocation, expiry and provider replacement during slow SSM calls prevent success',async()=>{
    for(const change of ['revoked','expired','provider']){
        const f=await polling();f.deps.invocation=async()=>{
            if(change==='revoked')f.state.authorized=false;
            if(change==='expired')f.state.now=f.input.work.authorization.expiresAt*1000;
            if(change==='provider')f.state.writer=false;return f.invocation;
        };
        const r=await f.helper(f.event);
        if(change==='provider')assert.deepEqual(r,{decision:'unconfirmed'});else assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
    }
});
test('workflow has no mutating retry and cleanup has no success path',()=>{
    for(const recovery of [false,true]){
        const d=mountDefinition('arn:fixture',recovery);assert.equal('Retry' in d.States.Dispatch,false);
        assert.equal(d.States.Dispatch.Catch[0]!.Next,'LostResponse');assert.equal(d.States.ObserveLost.Parameters.mode,'lost');
        assert.equal('Succeeded' in d.States,!recovery);
    }
});
