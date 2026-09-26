import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, parseInput, hostOperation, hostObservation, receiptFor, SettingsSchema } from '../lib/start/contract.js';
import { signature, requestAuthority, validWriter } from '../lib/start/aws.js';
import { createStartHelper } from '../lib/start/helper.js';
import { startDefinition } from '../lib/start/definition.js';
import { fixture, providerFixture, settings } from './start-fixture.js';

test('strict work binds the prepared configuration, per-writer IAM, control key and five-minute grant',()=>{
    const {input:i}=fixture();assert.deepEqual(SettingsSchema.parse(settings),settings);assert.deepEqual(parseInput(i,settings),i);
    const change=(mutate:(value:typeof i)=>void)=>{const v=structuredClone(i);mutate(v);return v;};
    const changes=[{...i,extra:'private'},
        ...['null',''].map(versionId=>change(v=>v.configuration.object.versionId=versionId)),
        change(v=>v.configuration.object.key='../other'), change(v=>v.configuration.object.bucket='other-bucket'),
        change(v=>v.configuration.object.bytes++), change(v=>v.configuration.object.sha256='0'.repeat(64)),
        change(v=>v.configuration.digest='0'.repeat(64)), change(v=>v.configuration.configurationId=v.work.authorizationId),
        change(v=>v.configuration.revision++), change(v=>v.configuration.operation='reload'),
        change(v=>v.configuration.scope.computerGeneration++), change(v=>v.work.configuration.bytes=262145),
        change(v=>v.work.deployment.instanceProfileArn='arn:aws:iam::123456789012:instance-profile/admin'),
        change(v=>v.work.expiresAt++), change(v=>v.work.expiresAt--), change(v=>v.work.issuedAt=Number.MAX_SAFE_INTEGER),
        change(v=>v.work.controlKey.versionId='not-a-version'),
        change(v=>v.work.controlKey.secretArn=v.work.controlKey.secretArn.replace('/generations/1/','/generations/2/')),
        change(v=>v.work.controlKey.secretArn+='extra'), change(v=>v.work.controlKey.policy.namespace='other'),
        change(v=>v.work.controlKey.policy.controlDomain='other.example.com'),
        change(v=>v.work.controlKey.policy.kmsKeyArn=v.work.deployment.dataKeyArn)];
    for(const c of changes)assert.throws(()=>parseInput(c,settings),/^Error: start_input_invalid$/);
    assert.equal(SettingsSchema.safeParse({...settings,controlKeyPolicy:{...settings.controlKeyPolicy,accountId:'000000000000'}}).success,false);
});
test('host envelope preserves the exact existing Delivery and distinct provisioning key',()=>{
    const {input:i}=fixture();
    for(const action of ['start','observe','cancel'] as const){
        const v=JSON.parse(Buffer.from(hostOperation(i,settings,action),'base64').toString());
        assert.deepEqual(Object.keys(v).sort(),['action','records','schemaVersion']);assert.equal(v.action,action);
        assert.deepEqual(Object.keys(v.records).sort(),['authorization','provisioning']);
        assert.deepEqual(v.records.authorization,{schemaVersion:1,authorizationId:i.work.authorizationId,
            mountAuthorizationId:i.work.mountAuthorizationId,configuration:i.configuration,
            secretVersionId:i.work.controlKey.versionId,controlDomain:i.work.controlKey.policy.controlDomain,
            issuedAt:i.work.issuedAt,expiresAt:i.work.expiresAt});
        assert.equal(v.records.provisioning.kmsKeyArn,i.work.deployment.dataKeyArn);
        assert.notEqual(v.records.provisioning.kmsKeyArn,i.work.controlKey.policy.kmsKeyArn);
    }
});
test('only exact scoped started receipts survive host output parsing',()=>{
    const {input:i}=fixture(),a=i.work;
    const v={schemaVersion:1,authorizationId:a.authorizationId,scope:a.scope,status:'succeeded',result:receiptFor(i)};
    assert.equal(hostObservation(canonical(v),i),'succeeded');
    for(const invalid of [{...v,status:'running'},{...v,result:undefined},{...v,result:{...v.result,descriptor:{...v.result.descriptor,configurationRevision:2}}},
        {...v,scope:{...a.scope,computerGeneration:2}},{...v,secret:'private'}])assert.throws(()=>hostObservation(canonical(invalid),i));
});
test('current-authority protocol matches the distinct HTTP realm and exact work',async()=>{
    const {input:i}=fixture(),key='1'.repeat(64);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async(url,init)=>{
        assert.equal(url,'https://cloud.ezil.org/api/internal/computers/start-authority');assert.equal(init?.redirect,'error');
        const h=new Headers(init?.headers);assert.equal(h.has('authorization'),false);assert.deepEqual(JSON.parse(String(init?.body)),i.work);
        assert.equal(h.get('x-ezil-workflow-signature'),signature(String(init?.body),key,h.get('x-ezil-workflow-timestamp')!));
        return Response.json({authorized:true,work:i.work});
    }),true);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async()=>Response.json({code:'revoked'},{status:403})),false);
    assert.equal(await requestAuthority(settings.authorityOrigin,key,i,async()=>Response.json({authorized:true})),false);
    for(const response of [new Response('secret',{status:302}),new Response('x'.repeat(16385)),new Response('private',{status:500})])
        await assert.rejects(requestAuthority(settings.authorityOrigin,key,i,async()=>response),/^Error: start_authority_unavailable$/);
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
        if(condition==='expired')f.state.now=f.input.work.expiresAt*1000;
        if(condition==='provider')f.state.writer=false;
        if(condition==='unavailable')f.deps.authority=async()=>{throw new Error('private');};
        if(condition==='slow')f.deps.authority=async()=>{f.state.now=f.input.work.expiresAt*1000;return true;};
        const r=await createStartHelper(settings,f.deps)(f.event);
        if(condition==='provider')assert.deepEqual(r,{decision:'unconfirmed'});
        else {assert.equal(r.decision,'dispatch');if(r.decision!=='dispatch')throw new Error();assert.equal(r.attempt.action,condition==='approved'?'start':'cancel');}
    }
});
test('a stalled authority body has a hard deadline and is cancelled',async()=>{
    let cancelled=false;const start=Date.now();
    const body=new ReadableStream<Uint8Array>({cancel(){cancelled=true;}});
    await assert.rejects(requestAuthority(settings.authorityOrigin,'1'.repeat(64),fixture().input,
        async()=>new Response(body,{headers:{'content-type':'application/json'}})),/^Error: start_authority_unavailable$/);
    assert.equal(cancelled,true);assert.ok(Date.now()-start<10000);
});
test('lost command responses only observe the same operation; expiry causes cancellation',async()=>{
    const f=fixture(),helper=createStartHelper(settings,f.deps),first=await helper(f.event);if(first.decision!=='dispatch')throw new Error();
    f.state.now+=5000;let r=await helper({...f.event,mode:'lost',attempt:first.attempt});assert.equal(r.decision==='dispatch'&&r.attempt.action,'observe');
    f.state.now=f.input.work.expiresAt*1000;r=await helper({...f.event,mode:'lost',attempt:first.attempt});
    assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
});
test('revoked historical cleanup cannot start work or report a started success',async()=>{
    const f=fixture();Object.assign(f.state.execution,{status:'ABORTED'});f.deps.authority=async()=>{throw new Error('must not call');};
    const r=await createStartHelper(settings,f.deps)({...f.event,recovery:true});assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
});
test('forged executions, aliases, redrives and changed immutable input fail redacted',async()=>{
    for(const change of [{stateMachineVersionArn:settings.machineArn+':2'},{redriveCount:1},{stateMachineAliasArn:'alias'},
        {name:'other'},{input:'private'},{startDate:new Date(0)}]){
        const f=fixture();Object.assign(f.state.execution,change);
        await assert.rejects(createStartHelper(settings,f.deps)(f.event),/^Error: start_workflow_unavailable$/);
    }
});
async function polling(status='succeeded'){
    const f=fixture(),helper=createStartHelper(settings,f.deps),r=await helper(f.event);if(r.decision!=='dispatch')throw new Error();
    const id='55555555-5555-4555-8555-555555555555';f.state.now+=5000;
    const command={...r.parameters,CommandId:id,RequestedDateTime:new Date(r.attempt.issuedAt)};
    const invocation={CommandId:id,InstanceId:f.input.work.scope.providerInstanceId,DocumentName:settings.documentName,
        DocumentVersion:settings.documentVersion,PluginName:'operateStart',Status:'Success' as const,ResponseCode:0,StandardOutputContent:canonical({
            schemaVersion:1,authorizationId:f.input.work.authorizationId,scope:f.input.work.scope,status,
            ...(status==='succeeded'?{result:receiptFor(f.input)}:{})})};
    f.deps.command=async()=>command;f.deps.invocation=async()=>invocation;
    const event={...f.event,mode:'poll',attempt:r.attempt,commandId:id};return {...f,helper,event,command,invocation};
}
test('bound SSM output returns the raw receipt and rechecks both authorities',async()=>{
    const f=await polling();assert.deepEqual(await f.helper(f.event),{decision:'success',result:receiptFor(f.input)});
    assert.equal(f.state.authorityCalls,3);
});
test('SSM command completion alone never becomes a start receipt',async()=>{
    for(const status of ['absent','unknown','running','failed','cancelling','cancelled']){
        const f=await polling(status),r=await f.helper(f.event);
        if(status==='cancelled')assert.deepEqual(r,{decision:'cancelled'});
        else assert.equal(r.decision==='dispatch'&&r.attempt.action,['failed','cancelling'].includes(status)?'cancel':'observe');
    }
    const f=await polling();f.invocation.StandardOutputContent='{}';await assert.rejects(f.helper(f.event),/^Error: start_workflow_unavailable$/);
});
test('forged SSM targets and plugin outcomes are not accepted',async()=>{
    const f=await polling();f.command.InstanceIds=['i-00000000000000000'];await assert.rejects(f.helper(f.event));
    const g=await polling();g.invocation.PluginName='operateConfiguration';await assert.rejects(g.helper(g.event));
});
test('missing, invalid and out-of-window command timestamps cannot authenticate output',async()=>{
    for(const time of [new Date(NaN),new Date(0),new Date(Date.now()+3600000)]) {
        const f=await polling();f.command.RequestedDateTime=time;
        await assert.rejects(f.helper(f.event),/^Error: start_workflow_unavailable$/);
    }
    const f=await polling();f.deps.command=async()=>({...f.command,RequestedDateTime:undefined});
    await assert.rejects(f.helper(f.event),/^Error: start_workflow_unavailable$/);
});
test('revocation, expiry and provider replacement during slow SSM calls prevent success',async()=>{
    for(const change of ['revoked','expired','provider']){
        const f=await polling();f.deps.invocation=async()=>{
            if(change==='revoked')f.state.authorized=false;
            if(change==='expired')f.state.now=f.input.work.expiresAt*1000;
            if(change==='provider')f.state.writer=false;return f.invocation;
        };
        const r=await f.helper(f.event);
        if(change==='provider')assert.deepEqual(r,{decision:'unconfirmed'});else assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
    }
});
test('workflow has no mutating retry and cleanup has no success path',()=>{
    for(const recovery of [false,true]){
        const d=startDefinition('arn:fixture',recovery);assert.equal('Retry' in d.States.Dispatch,false);
        assert.equal(d.States.Dispatch.Catch[0]!.Next,'LostResponse');assert.equal(d.States.ObserveLost.Parameters.mode,'lost');
        assert.equal('Succeeded' in d.States,!recovery);
    }
});
test('pending SSM commands get 180 seconds of visibility without another start',async()=>{
    const f=fixture(),helper=createStartHelper(settings,f.deps),first=await helper(f.event);
    if(first.decision!=='dispatch')throw new Error();
    const event={...f.event,mode:'poll',attempt:first.attempt,commandId:'55555555-5555-4555-8555-555555555555'};
    f.state.now=first.attempt.issuedAt+179999;
    assert.deepEqual(await helper(event),{decision:'wait',attempt:first.attempt});
    f.state.now++;
    const r=await helper(event);assert.equal(r.decision==='dispatch'&&r.attempt.action,'observe');
});
test('polling and recovery cannot extend the grant or cleanup deadline',async()=>{
    const f=fixture(),helper=createStartHelper(settings,f.deps);
    f.state.now=f.input.work.expiresAt*1000+300000;
    assert.deepEqual(await helper(f.event),{decision:'unconfirmed'});
    assert.equal(f.state.authorityCalls,0);
    Object.assign(f.state.execution,{status:'ABORTED'});
    const recovery={...f.event,recovery:true,recoveryStartedAt:new Date(f.state.now).toISOString()};
    let r=await helper(recovery);assert.equal(r.decision==='dispatch'&&r.attempt.action,'cancel');
    f.state.now+=300000;assert.deepEqual(await helper(recovery),{decision:'unconfirmed'});
    Object.assign(f.state.execution,{redriveCount:1});
    await assert.rejects(helper(recovery),/^Error: start_workflow_unavailable$/);
});
test('stopped or replacement writers never receive historical cancellation',async()=>{
    const f=fixture();Object.assign(f.state.execution,{status:'ABORTED'});f.state.writer=false;
    assert.deepEqual(await createStartHelper(settings,f.deps)({...f.event,recovery:true}),{decision:'unconfirmed'});
    assert.equal(f.state.authorityCalls,0);
});
